import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';

let server;
let scanMod;
let ildaMod;
let rendererMod;

before(async () => {
  server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });
  scanMod = await server.ssrLoadModule('/src/engine/ildaScanEnergy.ts');
  ildaMod = await server.ssrLoadModule('/src/data/ilda.ts');
  rendererMod = await server.ssrLoadModule('/src/engine/ildaRenderer.ts');
});

after(async () => {
  if (server) await server.close();
});

function clipFromPoints(points, name = 'SCAN') {
  return ildaMod.parseIlda(ildaMod.encodeIlda([{ name, format: 5, points }]), { tier: 'high' });
}

function point(x, y, overrides = {}) {
  return { x, y, r: 255, g: 80, b: 24, ...overrides };
}

describe('Sprint 21: global triangle and GPU-byte admission budgets', () => {
  it('uses allocated capacity across every projector, including awkward splits and zero-cap rigs', () => {
    for (const tier of ['low', 'high']) {
      const triangleCap = tier === 'low'
        ? scanMod.ILDA_SCAN_ENERGY_TRIANGLES_LOW
        : scanMod.ILDA_SCAN_ENERGY_TRIANGLES_HIGH;
      const byteCap = tier === 'low'
        ? scanMod.ILDA_SCAN_ENERGY_MAX_BYTES_LOW
        : scanMod.ILDA_SCAN_ENERGY_MAX_BYTES_HIGH;
      for (const count of [1, 3, 7, 23, 2001, 9000]) {
        const budget = scanMod.ildaScanEnergyBudget(tier, count);
        assert.equal(budget.segmentsPerProjector, Math.floor((triangleCap / 2) / count));
        assert.equal(budget.allocatedSegments, budget.segmentsPerProjector * count);
        assert.equal(budget.allocatedTriangles, budget.allocatedSegments * 2);
        assert.equal(
          budget.extraBufferBytes,
          budget.allocatedSegments * scanMod.ILDA_SCAN_ENERGY_BYTES_PER_SEGMENT,
        );
        assert.ok(budget.allocatedTriangles <= triangleCap, `${tier}/${count} triangle cap`);
        assert.ok(budget.extraBufferBytes <= byteCap, `${tier}/${count} byte cap`);
      }
    }
    assert.equal(scanMod.ildaScanEnergyBudget('low', 2001).segmentsPerProjector, 0);
    assert.equal(scanMod.ildaScanEnergyBudget('high', 9000).segmentsPerProjector, 0);
    assert.equal(scanMod.ILDA_SCAN_ENERGY_BYTES_PER_SEGMENT, 240);
  });
});

describe('Sprint 21: dwell, corner, blanking and draw-range processing', () => {
  it('compacts bounded dwell runs, never bridges blanking, and preserves source timing point counts', () => {
    const clip = clipFromPoints([
      point(-24000, 0), point(-24000, 0), point(-24000, 0), point(-24000, 0), point(-24000, 0),
      point(0, 0),
      point(24000, 24000, { blanked: true, r: 0, g: 0, b: 0 }),
      point(0, 24000), point(24000, 24000),
    ]);
    const baked = new rendererMod.BakedIldaClip(clip);
    const ribbon = baked.createScanEnergyProjector(32, false);
    const result = ribbon.updateFrame(0, 'both');

    assert.equal(clip.frames[0].count, 9, 'original ILDA point count remains the scan-timing source');
    assert.equal(baked.frameRanges[0].sourcePointCount, 9);
    assert.equal(result.compactedLitPoints, 4, 'five identical dwell points collapse to one render point');
    assert.equal(result.requiredSegments, 6, '4 unique rays + 2 within-contour outlines');
    assert.equal(result.segments, 6);
    assert.equal(ribbon.geometry.drawRange.count, 36, 'ribbon range is six vertices per segment');

    const positions = ribbon.geometry.getAttribute('position').array;
    const others = ribbon.geometry.getAttribute('other').array;
    const colors = ribbon.geometry.getAttribute('ribbonColor').array;
    let maxColor = 0;
    for (let i = 0; i < result.segments * 18; i++) {
      assert.ok(Number.isFinite(positions[i]));
      assert.ok(Number.isFinite(others[i]));
      assert.ok(Number.isFinite(colors[i]));
      maxColor = Math.max(maxColor, colors[i]);
    }
    assert.ok(maxColor > 2.5, 'bounded dwell raises scan energy above a single point');
    assert.ok(maxColor <= 4.5 + 1e-6, 'dwell/corner energy is capped at 1.8x');

    const farZ = positions[2 + 4 * 18];
    let foundBlankedJump = false;
    for (let s = 4; s < result.segments; s++) {
      const base = s * 18;
      if (positions[base + 2] !== farZ || others[base + 2] !== farZ) continue;
      const dx = Math.abs(positions[base] - others[base]);
      const dy = Math.abs(positions[base + 1] - others[base + 1]);
      if (dx > 10 && dy > 10) foundBlankedJump = true;
    }
    assert.equal(foundBlankedJump, false, 'no outline triangle crosses the blanked jump');
    baked.dispose();
  });

  it('weights a sharp corner above a straight scan and keeps Beam/Graphic/Both ranges distinct', () => {
    const straight = clipFromPoints([point(-20000, 0), point(0, 0), point(20000, 0)], 'STRAIGHT');
    const corner = clipFromPoints([point(-20000, 0), point(0, 0), point(0, 20000)], 'CORNER');
    const straightRibbon = new scanMod.IldaScanEnergyProjector(straight, 16, false);
    const cornerRibbon = new scanMod.IldaScanEnergyProjector(corner, 16, false);

    assert.equal(straightRibbon.updateFrame(0, 'beam').segments, 3);
    assert.equal(straightRibbon.updateFrame(0, 'graphic').segments, 2);
    assert.equal(straightRibbon.updateFrame(0, 'both').segments, 5);
    straightRibbon.updateFrame(0, 'graphic');
    cornerRibbon.updateFrame(0, 'graphic');

    const straightColor = straightRibbon.geometry.getAttribute('ribbonColor').array;
    const cornerColor = cornerRibbon.geometry.getAttribute('ribbonColor').array;
    const straightMiddle = straightColor[6];
    const cornerMiddle = cornerColor[6];
    assert.ok(cornerMiddle > straightMiddle, '90-degree corner receives bounded scan-energy emphasis');
    straightRibbon.dispose();
    cornerRibbon.dispose();
  });

  it('falls back whole for a dense frame instead of truncating or leaving stale triangles', () => {
    const clip = ildaMod.parseIlda(ildaMod.encodeIlda([
      { name: 'SPARSE', format: 5, points: [point(-10000, 0), point(0, 10000), point(10000, 0)] },
      { name: 'DENSE', format: 5, points: Array.from({ length: 80 }, (_, i) => point(-30000 + i * 700, (i % 2) * 500)) },
    ]), { tier: 'high' });
    const ribbon = new scanMod.IldaScanEnergyProjector(clip, 20, false);
    const sparseResult = ribbon.updateFrame(0, 'both');
    assert.equal(sparseResult.fallback, false);
    assert.ok(ribbon.getStats().uploadBytes > 0);
    const result = ribbon.updateFrame(1, 'both');
    assert.equal(result.fallback, true);
    assert.equal(result.active, false);
    assert.ok(result.requiredSegments > 20);
    assert.equal(result.segments, 0);
    assert.equal(ribbon.geometry.drawRange.count, 0);
    assert.equal(ribbon.getStats().uploadBytes, 0, 'fallback reports no current ribbon upload');
    ribbon.dispose();
  });

  it('updates animated near-capacity frames without per-segment array literals', () => {
    const pointsA = Array.from({ length: 4000 }, (_, i) => point(-32000 + (i % 200) * 320, -25000 + Math.floor(i / 200) * 2400));
    const pointsB = Array.from({ length: 4000 }, (_, i) => point(32000 - (i % 200) * 320, 25000 - Math.floor(i / 200) * 2400));
    const clip = ildaMod.parseIlda(ildaMod.encodeIlda([
      { name: 'CAPA', format: 5, points: pointsA },
      { name: 'CAPB', format: 5, points: pointsB },
    ]), { tier: 'high' });
    const animated = new scanMod.IldaScanEnergyProjector(clip, 8000, false);
    const positionArray = animated.geometry.getAttribute('position').array;
    const resultA = animated.updateFrame(0, 'beam');
    assert.equal(resultA.segments, 4000);
    const resultB = animated.updateFrame(1, 'beam');
    assert.equal(resultB.segments, 4000);
    assert.equal(resultB, resultA, 'animated updates reuse the result object');
    assert.equal(animated.geometry.getAttribute('position').array, positionArray, 'fixed typed-array storage is reused');

    const source = readFileSync(join(process.cwd(), 'src/engine/ildaScanEnergy.ts'), 'utf8');
    const writeSegmentBody = source.slice(source.indexOf('private writeSegment('), source.indexOf('\n  updateFrame(', source.indexOf('private writeSegment(')));
    assert.doesNotMatch(writeSegmentBody, /const\s+(packedEdges|starts)\s*=\s*\[/, 'no per-segment array literals');
    animated.dispose();
  });
});

describe('Sprint 21: per-eye shader, monochrome and lifecycle contracts', () => {
  it('uses per-eye modelViewMatrix, deterministic parallel fallback, near-eye and near-plane fades', () => {
    const vert = scanMod.ILDA_SCAN_ENERGY_VERT;
    assert.match(vert, /modelViewMatrix \* vec4\(localStart/);
    assert.match(vert, /closestT = clamp/);
    assert.match(vert, /sideLenSq < 1e-8/);
    assert.match(vert, /fallbackAxis/);
    assert.match(vert, /nearestFrontDepth/);
    assert.match(vert, /smoothstep\(0\.18, 0\.42, nearestFrontDepth\)/);
    assert.doesNotMatch(vert, /uniform\s+vec3\s+cameraPosition/);
    assert.match(scanMod.ILDA_SCAN_ENERGY_FRAG, /core \* 1\.45 \+ halo/);
    assert.match(scanMod.ILDA_SCAN_ENERGY_FRAG, /mix\(0\.10, 0\.38, clamp\(uHaze/);
  });

  it('uses shader luminance for monochrome projectors and restores/disposes owned resources', () => {
    const clip = clipFromPoints([point(-10000, 0), point(10000, 0, { r: 0, g: 255, b: 0 })]);
    const baked = new rendererMod.BakedIldaClip(clip);
    const ribbon = baked.createScanEnergyProjector(8, true);
    assert.equal(ribbon.material.uniforms.uMonochrome.value, 1);
    assert.equal(baked.ownsGeometry(ribbon.geometry), true);
    ribbon.updateFrame(0, 'both');
    const beforeVersion = ribbon.material.version;
    baked.onContextRestored();
    assert.ok(ribbon.material.version > beforeVersion, 'context restore invalidates shader program');

    let geometryDisposed = 0;
    let materialDisposed = 0;
    ribbon.geometry.addEventListener('dispose', () => geometryDisposed++);
    ribbon.material.addEventListener('dispose', () => materialDisposed++);
    baked.dispose();
    baked.dispose();
    assert.equal(geometryDisposed, 1);
    assert.equal(materialDisposed, 1);
    assert.equal(baked.ownsGeometry(ribbon.geometry), false);
  });

  it('keeps renderer settings default-off and documents bounded approximation and fallback', () => {
    const settings = readFileSync(join(process.cwd(), 'src/engine/renderSettings.ts'), 'utf8');
    const docs = readFileSync(join(process.cwd(), 'docs/graphics.md'), 'utf8');
    assert.match(settings, /ildaScanEnergy: false/);
    assert.match(docs, /ILDA Scan-Energy Ribbons/);
    assert.match(docs, /not a physical galvo simulation/i);
    assert.match(docs, /legacy line fallback/i);
  });
});
