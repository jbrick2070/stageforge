import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const compiler = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom', optimizeDeps: { noDiscovery: true } });
after(() => compiler.close());
const {
  fixtureOptics, aerialGain, resolveMovingFixtureOptics, resolveCalibratedZoom,
  createCalibratedFrustum, evaluateCalibratedZoom,
} = await compiler.ssrLoadModule('/src/data/fixtureOptics.ts');
const { applyPreviewDimmerCurve, usesSquareLawPreviewDimmer } = await compiler.ssrLoadModule('/src/engine/fixtureDimmer.ts');

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

test('calibrated catalogue zoom admits only measured group pairings and keeps authored optics precedence', () => {
  const robe = { type: 'beam', catalogId: 'robe-megapointe' };
  const rogue = { type: 'wash', catalogId: 'chauvet-rogue-r1-beamwash' };
  assert.equal(resolveCalibratedZoom({ ...robe, type: 'floor_beam' }), resolveCalibratedZoom(robe));
  assert.ok(Object.isFrozen(resolveCalibratedZoom(robe)));
  for (const group of [
    { ...robe, type: 'wash' }, { ...rogue, type: 'beam' }, { ...rogue, type: 'floor_beam' },
    { type: 'beam' }, { type: 'beam', catalogId: 'claypaky-sharpy' },
    { ...robe, optics: { beamAngle: 7 } }, { ...rogue, optics: { profile: { manufacturer: 'Authored' } } },
  ]) {
    assert.equal(resolveCalibratedZoom(group), undefined);
  }
  const authored = resolveMovingFixtureOptics({ ...rogue, optics: { lumens: 321 } });
  assert.ok(authored.calibration);
  assert.equal(authored.configuredLumens, 321);
  assert.equal(authored.optics.lumens, 321);
  assert.equal(authored.hasAuthoredLumens, true);
  assert.equal(resolveMovingFixtureOptics(rogue).configuredLumens, null);
  assert.equal(resolveMovingFixtureOptics(robe).configuredLumens, 20375);
});

test('calibrated finite frustum changes slope monotonically around a fixed aperture and constant nominal flux', () => {
  const nearRadius = 0.09;
  for (const [type, catalogId, narrow, middle, wide] of [
    ['beam', 'robe-megapointe', 1.8, 11.4, 21],
    ['wash', 'chauvet-rogue-r1-beamwash', 4, 20.9, 37.8],
  ]) {
    const { calibration, optics } = resolveMovingFixtureOptics({ type, catalogId });
    const frustum = createCalibratedFrustum(optics, nearRadius);
    let previousSlope = 0;
    let nominalFlux;
    for (const [input, angle] of [[0, narrow], [0.5, middle], [1, wide]]) {
      assert.equal(evaluateCalibratedZoom(calibration, optics, input, frustum), frustum);
      assert.ok(Math.abs(frustum.beamAngleDeg - angle) < 1e-12);
      assert.equal(frustum.nearRadius, nearRadius);
      assert.equal(frustum.nominalLumens, optics.lumens);
      assert.ok(frustum.slope > previousSlope);
      assert.ok(Math.abs(frustum.slope - Math.tan(angle * Math.PI / 360)) < 1e-12);
      const flux = frustum.gain * 4 * Math.PI * Math.sin(angle * Math.PI / 720) ** 2;
      nominalFlux ??= flux;
      assert.ok(Math.abs(flux - nominalFlux) < 1e-9);
      previousSlope = frustum.slope;
    }
    assert.equal(frustum.endRadiusDelta, 0);
    for (const input of [-1, NaN, Infinity]) {
      assert.equal(evaluateCalibratedZoom(calibration, optics, input, frustum).beamAngleDeg, narrow);
    }
    assert.ok(Math.abs(evaluateCalibratedZoom(calibration, optics, 99, frustum).beamAngleDeg - wide) < 1e-12);
    const dark = resolveMovingFixtureOptics({ type, catalogId, optics: { lumens: 0 } });
    assert.equal(evaluateCalibratedZoom(dark.calibration, dark.optics, 0.5, createCalibratedFrustum(dark.optics, nearRadius)).gain, 0);
  }
});

test('only explicitly catalogued MegaPointe beam types use the normalized square-law preview response', () => {
  assert.equal(usesSquareLawPreviewDimmer('beam', 'robe-megapointe'), true);
  assert.equal(usesSquareLawPreviewDimmer('floor_beam', 'robe-megapointe'), true);
  assert.equal(usesSquareLawPreviewDimmer('wash', 'robe-megapointe'), false);
  assert.equal(usesSquareLawPreviewDimmer('wash', 'chauvet-rogue-r1-beamwash'), false);
  assert.equal(usesSquareLawPreviewDimmer('beam', 'claypaky-sharpy'), false);
  assert.equal(usesSquareLawPreviewDimmer('floor_beam'), false);
  assert.equal(usesSquareLawPreviewDimmer('beam', 'MegaPointe'), false);

  const levels = [0, 0.25, 0.5, 0.75, 1];
  assert.deepEqual(levels.map((x) => applyPreviewDimmerCurve(x, true)), [0, 0.0625, 0.25, 0.5625, 1]);
  assert.deepEqual(levels.map((x) => applyPreviewDimmerCurve(x, false)), levels);
  assert.equal(applyPreviewDimmerCurve(0.999, true), 0.999 * 0.999);
  assert.equal(applyPreviewDimmerCurve(1.001, true), 1.001);
  assert.equal(applyPreviewDimmerCurve(1.6, true), 1.6);
});
