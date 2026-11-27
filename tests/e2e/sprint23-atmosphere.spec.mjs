import { playSynthDemo } from '../support/play-synth-demo.mjs';
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';

const authoredShow = join(process.cwd(), 'tests', 'fixtures', 'native-authoring-v3.stageforge.show.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function waitFrames(page, count = 4) {
  await page.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, count);
}

async function settleAtmosphere(page, steps = 12) {
  await page.evaluate((count) => { for (let i = 0; i < count; i++) window.stageforgeProbe.stepAndReadLuminance(250); }, steps);
}

async function loadMode(page, enabled, width = 1280, height = 720) {
  await page.setViewportSize({ width, height });
  if (page.url() === 'about:blank') await page.goto('/?probe');
  await page.evaluate((lookAtmosphere) => {
    localStorage.clear();
    localStorage.setItem('stageforge.render.v1', JSON.stringify({ lookAtmosphere }));
  }, enabled);
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.graphicsProbe)).toBe('function');
  await playSynthDemo(page);
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.evaluate(() => {
    const p = window.stageforgeProbe;
    p.resetParticles(0x23d0cafe);
    p.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: false,
      masterDimmer: 1,
      primaryColor: '#00d9ff',
      accentColor: '#ff2d86',
      colorSplitMode: 'alternate',
      movingGroups: {
        beam: { primaryColor: '#00d9ff', accentColor: '#0066ff', colorSplitMode: 'alternate' },
        wash: { primaryColor: '#ff2d86', accentColor: '#ff6a00', colorSplitMode: 'alternate' },
      },
      beamIntensity: 0.82,
      washIntensity: 0.68,
      blinderLevel: 0,
      strobeRate: 0,
      movementMode: 'fan',
      movementSpeed: 0,
      movementSpread: 0.72,
      bloomStrength: 0.38,
      atmo: { hazeLevel: 0.82, smokeOutput: 0, co2Active: false, co2AutoOnDrop: false },
      led: { enabled: true, brightness: 0.58, visualMode: 'custom', customMediaUrl: null, customMediaType: null, speed: 0 },
      laser: { enabled: false, intensity: 0, strobe: 0 },
    });
  });
  await settleAtmosphere(page);
}

async function captureViews(page, views) {
  return page.evaluate(async (defs) => {
    const p = window.stageforgeProbe, out = [];
    for (const view of defs) {
      p.setCameraPose(view.pos, view.target);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      out.push({ name: view.name, dataUrl: p.redrawAndCapture() });
    }
    return out;
  }, views);
}

async function compareAndCompose(page, off, on, views) {
  return page.evaluate(async ({ before, after, defs }) => {
    const decode = (url) => new Promise((resolve, reject) => {
      const image = new Image(); image.onerror = reject; image.src = url;
      image.onload = () => {
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        resolve({ image, pixels: ctx.getImageData(0, 0, image.width, image.height) });
      };
    });
    const results = [];
    for (let n = 0; n < defs.length; n++) {
      const a = await decode(before[n].dataUrl), b = await decode(after[n].dataUrl);
      const [rx0, ry0, rx1, ry1] = defs[n].region;
      const x0 = Math.floor(a.pixels.width * rx0), x1 = Math.ceil(a.pixels.width * rx1);
      const y0 = Math.floor(a.pixels.height * ry0), y1 = Math.ceil(a.pixels.height * ry1);
      let changed = 0, strong = 0, sum = 0, count = 0, black = 0, clipped = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * a.pixels.width + x) * 4;
        const d = Math.max(Math.abs(a.pixels.data[i] - b.pixels.data[i]), Math.abs(a.pixels.data[i + 1] - b.pixels.data[i + 1]), Math.abs(a.pixels.data[i + 2] - b.pixels.data[i + 2]));
        if (d > 2) changed++; if (d > 64) strong++; sum += d / 255; count++;
        const luma = (0.2126 * b.pixels.data[i] + 0.7152 * b.pixels.data[i + 1] + 0.0722 * b.pixels.data[i + 2]) / 255;
        if (luma < 0.035) black++; if (luma > 0.96) clipped++;
      }
      const panel = document.createElement('canvas'); panel.width = 960; panel.height = 292;
      const ctx = panel.getContext('2d'); ctx.fillStyle = '#05070b'; ctx.fillRect(0, 0, 960, 292);
      ctx.drawImage(a.image, 0, 22, 480, 270); ctx.drawImage(b.image, 480, 22, 480, 270);
      ctx.fillStyle = '#e5e7eb'; ctx.font = '600 14px sans-serif';
      ctx.fillText('Before — neutral global fog', 10, 16); ctx.fillText('After — bounded fixture-palette depth', 490, 16);
      results.push({ name: defs[n].name, changedFraction: changed / count, strongFraction: strong / count, meanDelta: sum / count, blackFraction: black / count, clippedFraction: clipped / count, dataUrl: panel.toDataURL('image/webp', 0.80) });
    }
    return results;
  }, { before: off, after: on, defs: views });
}

async function actualExports(page) {
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Show files' });
  const get = async (name) => {
    const pending = page.waitForEvent('download'); await dialog.getByRole('button', { name }).click();
    const download = await pending, bytes = await readFile(await download.path());
    await expect(dialog.getByText('Preparing file…')).toBeHidden(); return bytes;
  };
  const result = { mvr: await get(/Rig for consoles and visualizers/), dxf: await get(/CAD plan/), glb: await get(/3D scene/), paperwork: await get(/Patch sheet \(per unit\)/) };
  await dialog.getByRole('button', { name: 'Close Show files' }).click(); return result;
}

function glbFingerprint(bytes) {
  const jsonLen = bytes.readUInt32LE(12), json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLen));
  return { nodes: (json.nodes ?? []).map((n) => n.name ?? '').sort(), meshes: (json.meshes ?? []).map((m) => m.name ?? '').sort(), materials: json.materials ?? [], textures: json.textures ?? [], images: (json.images ?? []).map((x) => x.mimeType), accessors: (json.accessors ?? []).map((a) => [a.componentType, a.count, a.type, a.min, a.max]) };
}
function mvrFingerprint(bytes) {
  const archive = unzipSync(new Uint8Array(bytes));
  return Object.fromEntries(Object.entries(archive).sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) => [name, sha256(data)]));
}

test('Sprint 23D: coloured depth visuals, policies, exports, lifecycle, safety and warmed budgets', async ({ page }) => {
  test.setTimeout(540_000);
  const views = [
    { name: 'foh', pos: [0, 6.2, 24.5], target: [0, 5.0, -0.6], region: [0.14, 0.14, 0.86, 0.88] },
    { name: 'deck-close', pos: [7.2, 2.4, 10.5], target: [0, 2.3, -1.2], region: [0.02, 0.10, 0.98, 0.88] },
    { name: 'wide', pos: [-16, 9.5, 31], target: [0, 4.8, 0], region: [0.06, 0.10, 0.94, 0.90] },
  ];

  await loadMode(page, false);
  let probe = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(probe.atmosphere.requested).toBe(false); expect(probe.atmosphere.suppressedReason).toBe('disabled');
  const offViews = await captureViews(page, views);
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  let files = page.getByRole('dialog', { name: 'Show files' });
  await files.getByLabel('Open show file').setInputFiles(authoredShow); await expect(files).toBeHidden();
  const offExports = await actualExports(page);

  await loadMode(page, true);
  probe = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(probe.tier).toBe('high'); expect(probe.atmosphere.active).toBe(true);
  expect(probe.atmosphere.sumWeight).toBeGreaterThan(1); expect(probe.atmosphere.sceneOwnsFog).toBe(true);
  expect(probe.atmosphere.extraGpuBytes).toBe(0); expect(probe.resources.atmosphereExtraGpuBytes).toBe(0);
  expect(Math.max(...probe.atmosphere.target)).toBeLessThanOrEqual(0.060001);
  const targetLuma = 0.2126 * probe.atmosphere.target[0] + 0.7152 * probe.atmosphere.target[1] + 0.0722 * probe.atmosphere.target[2];
  expect(targetLuma).toBeLessThanOrEqual(0.025001);
  const onViews = await captureViews(page, views);
  const visual = await compareAndCompose(page, offViews, onViews, views);
  console.log('[SPRINT23D_LOCALIZED_LOOK]', JSON.stringify(visual.map(({ dataUrl: _dataUrl, ...x }) => x)));
  for (const result of visual) {
    expect(result.changedFraction).toBeGreaterThan(0.001);
    expect(result.strongFraction).toBeLessThan(0.08);
    expect(result.meanDelta).toBeLessThan(0.08);
    expect(result.blackFraction).toBeGreaterThan(0.01);
    expect(result.clippedFraction).toBeLessThan(0.15);
  }
  if (process.env.STAGEFORGE_UPDATE_LOOK_REFS === '1') {
    const dir = join(process.cwd(), 'docs', 'looks'); await mkdir(dir, { recursive: true });
    for (const result of visual) await writeFile(join(dir, `sprint23-d-${result.name}-before-after.webp`), Buffer.from(result.dataUrl.split(',')[1], 'base64'));
  }

  // The target follows opposing beam/wash palettes but never the strobe gate or preview governor.
  const strobeInvariant = await page.evaluate(() => {
    const p = window.stageforgeProbe, before = p.graphicsProbe().atmosphere;
    p.patchShowState({ strobeRate: 0.92 }); p.stepAndReadLuminance(100);
    const after = p.graphicsProbe().atmosphere; p.patchShowState({ strobeRate: 0 });
    return { before, after };
  });
  expect(strobeInvariant.after.palette).toEqual(strobeInvariant.before.palette);
  expect(strobeInvariant.after.target).toEqual(strobeInvariant.before.target);
  expect(strobeInvariant.after.sumWeight).toBe(strobeInvariant.before.sumWeight);

  // Cue transitions use the two-second filter; opposing colours average and move monotonically without a snap.
  const cue = await page.evaluate(() => {
    const p = window.stageforgeProbe;
    p.patchShowState({ movingGroups: { beam: { primaryColor: '#ff0000', accentColor: '#ff0000', colorSplitMode: 'solid' }, wash: { primaryColor: '#ff0000', accentColor: '#ff0000', colorSplitMode: 'solid' } } });
    for (let i = 0; i < 12; i++) p.stepAndReadLuminance(250);
    const red = p.graphicsProbe().atmosphere.current;
    p.patchShowState({ movingGroups: { beam: { primaryColor: '#0000ff', accentColor: '#0000ff', colorSplitMode: 'solid' }, wash: { primaryColor: '#0000ff', accentColor: '#0000ff', colorSplitMode: 'solid' } } });
    const samples = [];
    for (let i = 0; i < 8; i++) { p.stepAndReadLuminance(250); samples.push(p.graphicsProbe().atmosphere.current); }
    return { red, samples, target: p.graphicsProbe().atmosphere.target };
  });
  expect(cue.samples[0][0]).toBeLessThan(cue.red[0]); expect(cue.samples[0][2]).toBeGreaterThan(cue.red[2]);
  for (let i = 1; i < cue.samples.length; i++) { expect(cue.samples[i][0]).toBeLessThanOrEqual(cue.samples[i - 1][0]); expect(cue.samples[i][2]).toBeGreaterThanOrEqual(cue.samples[i - 1][2]); }

  // Zero haze, blackout, master zero, True colour, Reduced effects and reduced motion snap to neutral.
  const suppress = await page.evaluate(() => {
    const p = window.stageforgeProbe, out = {};
    const record = (key) => { p.stepAndReadLuminance(20); out[key] = p.graphicsProbe().atmosphere; };
    p.patchShowState({ atmo: { hazeLevel: 0 } }); record('zeroHaze');
    p.patchShowState({ atmo: { hazeLevel: 0.8 }, blackout: true }); record('blackout');
    p.patchShowState({ blackout: false, masterDimmer: 0 }); record('master');
    p.patchShowState({ masterDimmer: 1 }); p.setRenderSettings({ trueColour: true, reducedEffects: false }); record('trueColour');
    p.setRenderSettings({ trueColour: false, reducedEffects: true }); record('reduced');
    p.setRenderSettings({ reducedEffects: false }); p.setPrefersReducedMotion(true); record('motion');
    p.setPrefersReducedMotion(false); p.setRenderSettings({ lookAtmosphere: true }); p.patchShowState({ atmo: { hazeLevel: 0.82 } });
    return out;
  });
  expect(suppress.zeroHaze.suppressedReason).toBe('zero-haze'); expect(suppress.blackout.suppressedReason).toBe('blackout');
  expect(suppress.master.suppressedReason).toBe('master-dimmer'); expect(suppress.trueColour.suppressedReason).toBe('true-colour');
  expect(suppress.reduced.suppressedReason).toBe('reduced-effects'); expect(suppress.motion.suppressedReason).toBe('reduced-effects');

  // Renderer-only setting leaves real UI export entry points byte/canonically identical.
  await page.getByRole('button', { name: 'Show files', exact: true }).click(); files = page.getByRole('dialog', { name: 'Show files' });
  await files.getByLabel('Open show file').setInputFiles(authoredShow); await expect(files).toBeHidden();
  const onExports = await actualExports(page);
  expect(glbFingerprint(onExports.glb)).toEqual(glbFingerprint(offExports.glb)); expect(sha256(onExports.dxf)).toBe(sha256(offExports.dxf));
  expect(mvrFingerprint(onExports.mvr)).toEqual(mvrFingerprint(offExports.mvr)); expect(sha256(onExports.paperwork)).toBe(sha256(offExports.paperwork));
  await loadMode(page, true);

  // CPU-only state owns no lifecycle resource and never changes particle caps, draw count or passes.
  const lifecycle = await page.evaluate(async () => {
    const p = window.stageforgeProbe, next = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const before = p.graphicsProbe(); p.rebuildRig(); await next();
    p.patchShowState({ led: { visualMode: 'custom', customMediaUrl: '/examples/amber-clouds.png', customMediaType: 'image' } }); await next();
    p.patchShowState({ led: { visualMode: 'custom', customMediaUrl: null, customMediaType: null } });
    p.simulateContextLoss(true); p.simulateContextLoss(false); await next();
    return { before, after: p.graphicsProbe() };
  });
  await page.setViewportSize({ width: 1111, height: 703 }); await waitFrames(page, 3);
  const resized = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  for (const state of [lifecycle.before, lifecycle.after, resized]) {
    expect(state.atmosphere.sceneOwnsFog).toBe(true); expect(state.atmosphere.extraGpuBytes).toBe(0);
    expect(state.particles.capacities).toEqual(lifecycle.before.particles.capacities); expect(state.activePasses).toEqual(lifecycle.before.activePasses);
  }
  expect(lifecycle.after.stats.calls).toBeLessThanOrEqual(lifecycle.before.stats.calls + 1);

  // Irregular cue transitions are assessed after bloom with affected-area and rolling one-second bounds.
  const safety = await page.evaluate(() => {
    const p = window.stageforgeProbe, dts = [17,31,19,43,23,37,29,41,17,47,23,31,19,53,17,37,29,41,23,43,17,31,29,47];
    p.patchShowState({ movingGroups: { beam: { primaryColor: '#ff0000', accentColor: '#ff0000', colorSplitMode: 'solid' }, wash: { primaryColor: '#ff0000', accentColor: '#ff0000', colorSplitMode: 'solid' } }, atmo: { hazeLevel: 0.82 }, strobeRate: 0 });
    p.setRenderSettings({ lookAtmosphere: false, bloom: 'auto' }); const samples = [{ t: 0, grid: p.stepAndReadLuminance(220).grid }];
    p.setRenderSettings({ lookAtmosphere: true }); let t = 0;
    for (let i = 0; i < dts.length; i++) { if (i === 8) p.patchShowState({ movingGroups: { beam: { primaryColor: '#0000ff', accentColor: '#0000ff', colorSplitMode: 'solid' }, wash: { primaryColor: '#0000ff', accentColor: '#0000ff', colorSplitMode: 'solid' } } }); t += dts[i]; samples.push({ t, grid: p.stepAndReadLuminance(dts[i]).grid }); }
    const edges = []; let maxAffected = 0, maxRedAffected = 0;
    for (let n = 1; n < samples.length; n++) { let affected = 0, red = 0; for (let i = 0; i < samples[n].grid.cells.length; i++) { const a = samples[n - 1].grid.cells[i], b = samples[n].grid.cells[i]; if (Math.abs(b.y - a.y) >= 0.10) affected++; if (Math.abs(b.red - a.red) >= 0.10) red++; } const f = affected / samples[n].grid.cells.length, rf = red / samples[n].grid.cells.length; if (f >= 0.25 || rf >= 0.25) edges.push(samples[n].t); maxAffected = Math.max(maxAffected, f); maxRedAffected = Math.max(maxRedAffected, rf); }
    let maxRolling = 0; for (const edge of edges) maxRolling = Math.max(maxRolling, edges.filter((x) => x > edge - 1000 && x <= edge).length);
    return { edges: edges.length, maxRolling, maxAffected, maxRedAffected };
  });
  console.log('[SPRINT23D_FINAL_BLOOM_SAFETY]', JSON.stringify(safety));
  expect(safety.edges).toBeLessThanOrEqual(1); expect(safety.maxRolling).toBeLessThanOrEqual(1); expect(safety.maxAffected).toBeLessThan(0.55); expect(safety.maxRedAffected).toBeLessThan(0.55);

  const measurePairs = async (pairs, warmupFrames, sampleFrames) => {
    const out = [];
    for (let i = 0; i < pairs; i++) for (const enabled of (i % 2 === 0 ? [false, true] : [true, false])) {
      await page.evaluate((lookAtmosphere) => window.stageforgeProbe.setRenderSettings({ lookAtmosphere, trueColour: false, reducedEffects: false }), enabled);
      await waitFrames(page, 3);
      const report = await page.evaluate((x) => window.stageforgeProbe.measureFrames(x), { warmupFrames, sampleFrames, gpu: true });
      out.push({ enabled, report, probe: await page.evaluate(() => window.stageforgeProbe.graphicsProbe()) });
    }
    return out;
  };
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summarize = (pairs) => ({ offP50: pairs.filter((x) => !x.enabled).map((x) => x.report.cpuTotalMs.p50), onP50: pairs.filter((x) => x.enabled).map((x) => x.report.cpuTotalMs.p50), offP95: pairs.filter((x) => !x.enabled).map((x) => x.report.cpuTotalMs.p95), onP95: pairs.filter((x) => x.enabled).map((x) => x.report.cpuTotalMs.p95), offP99: pairs.filter((x) => !x.enabled).map((x) => x.report.cpuTotalMs.p99), onP99: pairs.filter((x) => x.enabled).map((x) => x.report.cpuTotalMs.p99), gpuOffP50: pairs.filter((x) => !x.enabled).map((x) => x.report.gpuMs.p50), gpuOnP50: pairs.filter((x) => x.enabled).map((x) => x.report.gpuMs.p50) });

  await page.setViewportSize({ width: 1280, height: 720 }); const laptopPairs = await measurePairs(5, 12, 48), laptop = summarize(laptopPairs);
  laptop.deltaP50 = Number((median(laptop.onP50) - median(laptop.offP50)).toFixed(3)); laptop.debugRenderer = laptopPairs[0].probe.debugRenderer;
  const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await loadMode(page, true, 390, 844); const phonePairs = await measurePairs(5, 10, 40), phone = summarize(phonePairs);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); phone.deltaP50 = Number((median(phone.onP50) - median(phone.offP50)).toFixed(3)); phone.debugRenderer = phonePairs[0].probe.debugRenderer;
  console.log('[SPRINT23D_BUDGET]', JSON.stringify({ laptop, phone, measurementResolutionMs: 0.1 }));
  expect(laptop.deltaP50).toBeLessThanOrEqual(0.10); expect(phone.deltaP50).toBeLessThanOrEqual(0.20);
  expect(laptopPairs.find((x) => x.enabled).probe.stats.calls).toBe(laptopPairs.find((x) => !x.enabled).probe.stats.calls);
  expect(laptopPairs.find((x) => x.enabled).probe.resources.atmosphereExtraGpuBytes).toBe(0);
  expect(phonePairs.find((x) => x.enabled).probe.tier).toBe('low'); expect(phonePairs.find((x) => x.enabled).probe.atmosphere.active).toBe(false);
  expect(phonePairs.find((x) => x.enabled).probe.atmosphere.suppressedReason).toBe('reduced-effects');
});
