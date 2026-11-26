import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';

const authoredShow = join(process.cwd(), 'tests', 'fixtures', 'native-authoring-v3.stageforge.show.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function waitFrames(page, count = 4) {
  await page.evaluate((n) => new Promise((resolve) => {
    let left = n;
    const step = () => { if (--left <= 0) resolve(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), count);
}

async function loadMode(page, enabled, width = 1280, height = 720) {
  await page.setViewportSize({ width, height });
  if (page.url() === 'about:blank') await page.goto('/?probe');
  await page.evaluate((lookWetDeck) => {
    localStorage.clear();
    localStorage.setItem('stageforge.render.v1', JSON.stringify({ lookWetDeck }));
  }, enabled);
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.graphicsProbe)).toBe('function');
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.evaluate(() => window.stageforgeProbe.patchShowState({
    autoDirector: false,
    audioReactive: false,
    blackout: false,
    masterDimmer: 1,
    primaryColor: '#00d9ff',
    accentColor: '#ff2d86',
    beamIntensity: 0.72,
    washIntensity: 0.62,
    blinderLevel: 0,
    strobeRate: 0,
    movementMode: 'manual',
    manualPan: 0,
    manualTilt: 0.42,
    bloomStrength: 0.38,
    led: { enabled: true, brightness: 0.62, visualMode: 'custom', customMediaUrl: null, customMediaType: null, speed: 0 },
    laser: { enabled: false, intensity: 0, strobe: 0 },
  }));
  await waitFrames(page, 8);
}

async function captureViews(page, views) {
  return page.evaluate(async (defs) => {
    const p = window.stageforgeProbe;
    const out = [];
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
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        resolve({ image, pixels: ctx.getImageData(0, 0, image.width, image.height) });
      };
      image.onerror = reject; image.src = url;
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
        if (d > 2) changed++;
        if (d > 64) strong++;
        sum += d / 255; count++;
        const luma = (0.2126 * b.pixels.data[i] + 0.7152 * b.pixels.data[i + 1] + 0.0722 * b.pixels.data[i + 2]) / 255;
        if (luma < 0.035) black++;
        if (luma > 0.96) clipped++;
      }
      const panel = document.createElement('canvas'); panel.width = 960; panel.height = 292;
      const ctx = panel.getContext('2d'); ctx.fillStyle = '#05070b'; ctx.fillRect(0, 0, 960, 292);
      ctx.drawImage(a.image, 0, 22, 480, 270); ctx.drawImage(b.image, 480, 22, 480, 270);
      ctx.fillStyle = '#e5e7eb'; ctx.font = '600 14px sans-serif';
      ctx.fillText('Before — legacy environment', 10, 16); ctx.fillText('After — neutral wet-deck composition', 490, 16);
      results.push({
        name: defs[n].name,
        changedFraction: changed / count,
        strongFraction: strong / count,
        meanDelta: sum / count,
        blackFraction: black / count,
        clippedFraction: clipped / count,
        dataUrl: panel.toDataURL('image/webp', 0.80),
      });
    }
    return results;
  }, { before: off, after: on, defs: views });
}

async function actualExports(page) {
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Show files' });
  const get = async (name) => {
    const pending = page.waitForEvent('download');
    await dialog.getByRole('button', { name }).click();
    const download = await pending;
    const bytes = await readFile(await download.path());
    await expect(dialog.getByText('Preparing file…')).toBeHidden();
    return bytes;
  };
  const result = {
    mvr: await get(/Rig for consoles and visualizers/),
    dxf: await get(/CAD plan/),
    glb: await get(/3D scene/),
    paperwork: await get(/Patch sheet \(per unit\)/),
  };
  await dialog.getByRole('button', { name: 'Close Show files' }).click();
  return result;
}

function glbFingerprint(bytes) {
  const jsonLen = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLen));
  return {
    nodes: (json.nodes ?? []).map((n) => n.name ?? '').sort(),
    meshes: (json.meshes ?? []).map((m) => m.name ?? '').sort(),
    materials: json.materials ?? [], textures: json.textures ?? [],
    images: (json.images ?? []).map((image) => ({ mimeType: image.mimeType })),
    accessors: (json.accessors ?? []).map((a) => [a.componentType, a.count, a.type, a.min, a.max]),
  };
}

function mvrFingerprint(bytes) {
  const archive = unzipSync(new Uint8Array(bytes));
  return Object.fromEntries(Object.entries(archive).sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) => [name, sha256(data)]));
}

test('Sprint 23C: wet deck composition, exports, lifecycle, safety and warmed budgets', async ({ page }) => {
  test.setTimeout(480_000);
  let views = [
    { name: 'foh', pos: [0, 6.2, 24.5], target: [0, 4.0, -0.6], region: [0.18, 0.42, 0.82, 0.90] },
    { name: 'deck-close', pos: [7.2, 2.25, 10.5], target: [0, 0.8, 0], region: [0.03, 0.35, 0.97, 0.97] },
    { name: 'wide', pos: [-16, 9.5, 31], target: [0, 4.0, 0], region: [0.08, 0.35, 0.92, 0.92] },
  ];

  await loadMode(page, false);
  const rig = await page.evaluate(() => window.stageforgeProbe.rig());
  views = views.map((view) => view.name === 'deck-close' ? {
    ...view,
    pos: [5.0, rig.stageHeight + 0.58, rig.stageDepth * 0.42],
    target: [0, rig.stageHeight, rig.stageDepth * 0.18],
    region: [0.02, 0.25, 0.98, 0.98],
  } : view);
  let probe = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(probe.wetDeck.composition).toBe('legacy');
  expect(probe.wetDeck.persistentTargetCount).toBe(1);
  expect(probe.wetDeck.sceneOwnsTargetTexture).toBe(true);
  const legacyDescriptor = { width: probe.wetDeck.targetWidth, height: probe.wetDeck.targetHeight };
  const offViews = await captureViews(page, views);

  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  let files = page.getByRole('dialog', { name: 'Show files' });
  await files.getByLabel('Open show file').setInputFiles(authoredShow);
  await expect(files).toBeHidden();
  const offExports = await actualExports(page);

  await loadMode(page, true);
  probe = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(probe.wetDeck.composition).toBe('wet-neutral');
  expect(probe.wetDeck.active).toBe(true);
  expect(probe.wetDeck.narrowStripCount).toBe(5);
  expect(probe.wetDeck.buildCount).toBe(1);
  expect(probe.wetDeck.persistentTargetCount).toBe(1);
  expect(probe.wetDeck.sceneOwnsTargetTexture).toBe(true);
  expect({ width: probe.wetDeck.targetWidth, height: probe.wetDeck.targetHeight }).toEqual(legacyDescriptor);
  expect(probe.resources.wetDeckExtraGpuBytes).toBe(0);
  expect(probe.deckSheen.extraTextureBytes).toBe(0);
  expect(probe.resources.sprint23ExtraGpuBytes).toBe(probe.resources.neonFrameExtraBufferBytes);
  const onViews = await captureViews(page, views);
  const visual = await compareAndCompose(page, offViews, onViews, views);
  console.log('[SPRINT23C_LOCALIZED_LOOK]', JSON.stringify(visual.map(({ dataUrl: _dataUrl, ...x }) => x)));
  for (const result of visual) {
    expect(result.changedFraction).toBeGreaterThan(0.002);
    expect(result.strongFraction).toBeLessThan(0.65);
    expect(result.meanDelta).toBeLessThan(0.32);
    expect(result.blackFraction).toBeGreaterThan(0.01);
    expect(result.clippedFraction).toBeLessThan(0.20);
  }
  if (process.env.STAGEFORGE_UPDATE_LOOK_REFS === '1') {
    const dir = join(process.cwd(), 'docs', 'looks'); await mkdir(dir, { recursive: true });
    for (const result of visual) {
      await writeFile(join(dir, `sprint23-c-${result.name}-before-after.webp`), Buffer.from(result.dataUrl.split(',')[1], 'base64'));
    }
  }

  // True colour introduces no wet-deck tint to bypass; Reduced effects retain this static PBR response.
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ trueColour: true, reducedEffects: false }));
  await waitFrames(page, 3);
  probe = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(probe.wetDeck.composition).toBe('wet-neutral');
  expect(probe.deckSheen.extraTextureBytes).toBe(0);
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ trueColour: false, reducedEffects: true }));
  await waitFrames(page, 3);
  expect((await page.evaluate(() => window.stageforgeProbe.graphicsProbe())).wetDeck.composition).toBe('wet-neutral');

  // Compare every authored exchange path at the same high tier, then return to the fixed Arena state.
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  files = page.getByRole('dialog', { name: 'Show files' });
  await files.getByLabel('Open show file').setInputFiles(authoredShow);
  await expect(files).toBeHidden();
  const onExports = await actualExports(page);
  expect(glbFingerprint(onExports.glb)).toEqual(glbFingerprint(offExports.glb));
  expect(sha256(onExports.dxf)).toBe(sha256(offExports.dxf));
  expect(mvrFingerprint(onExports.mvr)).toEqual(mvrFingerprint(offExports.mvr));
  expect(sha256(onExports.paperwork)).toBe(sha256(offExports.paperwork));
  await loadMode(page, true);
  await page.evaluate((view) => window.stageforgeProbe.setCameraPose(view.pos, view.target), views.find((view) => view.name === 'deck-close'));
  await waitFrames(page, 3);

  // Target ownership remains stable through resize, rebuild, media replacement and both restore paths.
  const lifecycle = await page.evaluate(async () => {
    const p = window.stageforgeProbe, next = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const before = p.graphicsProbe();
    p.rebuildRig(); await next();
    p.patchShowState({ led: { visualMode: 'custom', customMediaUrl: '/examples/amber-clouds.png', customMediaType: 'image' } });
    await next();
    p.patchShowState({ led: { visualMode: 'custom', customMediaUrl: null, customMediaType: null } });
    p.simulateContextLoss(true); p.simulateContextLoss(false); await next();
    const afterSimulated = p.graphicsProbe();
    const beforeRealUrl = p.redrawAndCapture();
    const canvas = document.querySelector('canvas'), gl = canvas?.getContext('webgl2'), ext = gl?.getExtension('WEBGL_lose_context');
    let realRestored = true;
    if (ext) {
      ext.loseContext(); await new Promise((r) => setTimeout(r, 60)); ext.restoreContext();
      for (let i = 0; i < 40 && p.graphicsProbe().contextLost; i++) await new Promise((r) => setTimeout(r, 40));
      for (let i = 0; i < 8; i++) await next();
      realRestored = !p.graphicsProbe().contextLost && p.graphicsProbe().wetDeck.sceneOwnsTargetTexture;
    }
    const after = p.graphicsProbe();
    const afterRealUrl = p.redrawAndCapture();
    const decode = (url) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
        const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0);
        resolve(ctx.getImageData(0, 0, c.width, c.height));
      };
      image.onerror = reject; image.src = url;
    });
    const a = await decode(beforeRealUrl), b = await decode(afterRealUrl);
    let sum = 0, changed = 0, beforeLuma = 0, afterLuma = 0, count = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
      sum += d / 255; if (d > 3) changed++;
      beforeLuma += (0.2126 * a.data[i] + 0.7152 * a.data[i + 1] + 0.0722 * a.data[i + 2]) / 255;
      afterLuma += (0.2126 * b.data[i] + 0.7152 * b.data[i + 1] + 0.0722 * b.data[i + 2]) / 255;
      count++;
    }
    beforeLuma /= count; afterLuma /= count;
    return { before, afterSimulated, after, realRestored, hadRealExtension: Boolean(ext), restoreMeanDelta: sum / count, restoreChangedFraction: changed / count, beforeLuma, afterLuma, lumaRelativeDelta: Math.abs(afterLuma - beforeLuma) / Math.max(0.001, beforeLuma) };
  });
  await page.setViewportSize({ width: 1111, height: 703 }); await waitFrames(page, 3);
  const resized = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(lifecycle.afterSimulated.wetDeck.targetUuid).toBe(lifecycle.before.wetDeck.targetUuid);
  expect(lifecycle.afterSimulated.wetDeck.buildCount).toBe(1);
  expect(lifecycle.afterSimulated.wetDeck.sceneOwnsTargetTexture).toBe(true);
  if (lifecycle.hadRealExtension) {
    expect(lifecycle.after.wetDeck.targetUuid).not.toBe(lifecycle.before.wetDeck.targetUuid);
    expect(lifecycle.after.wetDeck.buildCount).toBe(2);
  }
  expect(resized.wetDeck.targetUuid).toBe(lifecycle.after.wetDeck.targetUuid);
  expect(resized.wetDeck.buildCount).toBe(lifecycle.after.wetDeck.buildCount);
  for (const state of [lifecycle.after, resized]) {
    expect(state.wetDeck.persistentTargetCount).toBe(1);
    expect(state.wetDeck.sceneOwnsTargetTexture).toBe(true);
  }
  expect(lifecycle.realRestored).toBe(true);
  console.log('[SPRINT23C_CONTEXT_RESTORE]', JSON.stringify({ meanDelta: lifecycle.restoreMeanDelta, changedFraction: lifecycle.restoreChangedFraction, beforeLuma: lifecycle.beforeLuma, afterLuma: lifecycle.afterLuma, lumaRelativeDelta: lifecycle.lumaRelativeDelta, buildCount: lifecycle.after.wetDeck.buildCount }));
  expect(lifecycle.restoreMeanDelta).toBeLessThan(0.15);
  expect(lifecycle.beforeLuma).toBeGreaterThan(0.03);
  expect(lifecycle.afterLuma).toBeGreaterThan(0.03);
  expect(lifecycle.lumaRelativeDelta).toBeLessThan(0.25);

  // Camera sweep: localized mean luminance changes stay continuous, without a fixed full-frame streak.
  const sweep = await page.evaluate(async ({ deckY, depth }) => {
    const p = window.stageforgeProbe, means = [];
    for (let i = 0; i < 7; i++) {
      p.setCameraPose([-3 + i, deckY + 0.62, depth * 0.42], [0, deckY, depth * 0.12]);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      means.push(p.stepAndReadLuminance(32).grid.whole.y);
    }
    return means;
  }, { deckY: rig.stageHeight, depth: rig.stageDepth });
  const sweepJumps = sweep.slice(1).map((v, i) => Math.abs(v - sweep[i]));
  console.log('[SPRINT23C_CAMERA_SWEEP]', JSON.stringify({ sweep, maxJump: Math.max(...sweepJumps) }));
  expect(Math.max(...sweepJumps)).toBeLessThan(0.12);

  // Static C input adds at most one activation transition after final bloom under irregular frame timing.
  const safety = await page.evaluate(() => {
    const p = window.stageforgeProbe, dts = [17,31,19,43,23,37,29,41,17,47,23,31,19,53,17,37,29,41,23,43,17,31,29,47];
    p.setRenderSettings({ lookWetDeck: false, bloom: 'auto' });
    const grids = [p.stepAndReadLuminance(220).grid];
    p.setRenderSettings({ lookWetDeck: true, bloom: 'auto' });
    for (const dt of dts) grids.push(p.stepAndReadLuminance(dt).grid);
    let transitions = 0, maxAffected = 0, maxRedAffected = 0;
    for (let n = 1; n < grids.length; n++) {
      let affected = 0, red = 0;
      for (let i = 0; i < grids[n].cells.length; i++) {
        const a = grids[n - 1].cells[i], b = grids[n].cells[i];
        if (Math.abs(b.y - a.y) >= 0.10) affected++;
        if (Math.abs(b.red - a.red) >= 0.10) red++;
      }
      const fraction = affected / grids[n].cells.length, redFraction = red / grids[n].cells.length;
      if (fraction >= 0.25) transitions++;
      maxAffected = Math.max(maxAffected, fraction); maxRedAffected = Math.max(maxRedAffected, redFraction);
    }
    return { transitions, maxAffected, maxRedAffected };
  });
  console.log('[SPRINT23C_FINAL_BLOOM_SAFETY]', JSON.stringify(safety));
  expect(safety.transitions).toBeLessThanOrEqual(1);
  expect(safety.maxAffected).toBeLessThan(0.55);
  expect(safety.maxRedAffected).toBeLessThan(0.55);

  const measurePairs = async (pairs, warmupFrames, sampleFrames) => {
    const out = [];
    for (let i = 0; i < pairs; i++) for (const enabled of (i % 2 === 0 ? [false, true] : [true, false])) {
      await page.evaluate((lookWetDeck) => window.stageforgeProbe.setRenderSettings({ lookWetDeck }), enabled);
      await waitFrames(page, 3);
      const report = await page.evaluate(({ warmupFrames, sampleFrames }) => window.stageforgeProbe.measureFrames({ warmupFrames, sampleFrames, gpu: true }), { warmupFrames, sampleFrames });
      out.push({ enabled, report, probe: await page.evaluate(() => window.stageforgeProbe.graphicsProbe()) });
    }
    return out;
  };
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summarize = (pairs) => ({
    offP50: pairs.filter((x) => !x.enabled).map((x) => x.report.cpuTotalMs.p50), onP50: pairs.filter((x) => x.enabled).map((x) => x.report.cpuTotalMs.p50),
    offP95: pairs.filter((x) => !x.enabled).map((x) => x.report.cpuTotalMs.p95), onP95: pairs.filter((x) => x.enabled).map((x) => x.report.cpuTotalMs.p95),
    offP99: pairs.filter((x) => !x.enabled).map((x) => x.report.cpuTotalMs.p99), onP99: pairs.filter((x) => x.enabled).map((x) => x.report.cpuTotalMs.p99),
    gpuOffP50: pairs.filter((x) => !x.enabled).map((x) => x.report.gpuMs.p50), gpuOnP50: pairs.filter((x) => x.enabled).map((x) => x.report.gpuMs.p50),
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  const laptopPairs = await measurePairs(5, 12, 48), laptop = summarize(laptopPairs);
  laptop.deltaP50 = Number((median(laptop.onP50) - median(laptop.offP50)).toFixed(3));
  laptop.debugRenderer = laptopPairs[0].probe.debugRenderer;
  const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  // Recreate the engine at the phone-like viewport so detectRenderTier selects low. C is intentionally
  // bypassed there after the high-tier shader missed its software-rasterizer proxy budget.
  await loadMode(page, true, 390, 844);
  const phonePairs = await measurePairs(5, 10, 40), phone = summarize(phonePairs);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  phone.deltaP50 = Number((median(phone.onP50) - median(phone.offP50)).toFixed(3)); phone.debugRenderer = phonePairs[0].probe.debugRenderer;
  console.log('[SPRINT23C_BUDGET]', JSON.stringify({ laptop, phone, measurementResolutionMs: 0.1 }));
  expect(laptop.deltaP50).toBeLessThanOrEqual(0.20);
  expect(phone.deltaP50).toBeLessThanOrEqual(0.30);
  expect(laptopPairs.find((x) => x.enabled).probe.stats.calls).toBe(laptopPairs.find((x) => !x.enabled).probe.stats.calls);
  expect(phonePairs.find((x) => x.enabled).probe.resources.wetDeckExtraGpuBytes).toBe(0);
  expect(phonePairs.find((x) => x.enabled).probe.tier).toBe('low');
  expect(phonePairs.find((x) => x.enabled).probe.wetDeck.active).toBe(false);
  expect(phonePairs.find((x) => x.enabled).probe.wetDeck.composition).toBe('legacy');

  // A new phone-like engine selects the low tier while retaining the same one-target,
  // zero-incremental-allocation ownership contract. The prior engine is disposed on reload.
  const lowTier = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(lowTier.tier).toBe('low');
  expect(lowTier.wetDeck.requested).toBe(true);
  expect(lowTier.wetDeck.active).toBe(false);
  expect(lowTier.wetDeck.composition).toBe('legacy');
  expect(lowTier.wetDeck.persistentTargetCount).toBe(1);
  expect(lowTier.wetDeck.buildCount).toBe(1);
  expect(lowTier.wetDeck.sceneOwnsTargetTexture).toBe(true);
  expect(lowTier.wetDeck.targetUuid).not.toBe(lifecycle.after.wetDeck.targetUuid);
  expect({ width: lowTier.wetDeck.targetWidth, height: lowTier.wetDeck.targetHeight }).toEqual(legacyDescriptor);
  expect(lowTier.resources.wetDeckExtraGpuBytes).toBe(0);
  expect(lowTier.deckSheen.extraTextureBytes).toBe(0);
});
