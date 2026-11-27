import { playSynthDemo } from '../support/play-synth-demo.mjs';
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const authoredShow = fileURLToPath(new URL('../fixtures/native-authoring-v3.stageforge.show.json', import.meta.url));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function waitFrames(page, count = 4) {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  }, count);
}

async function settleLook(page, enabled) {
  await page.evaluate((lookNeonFrame) => window.stageforgeProbe.setRenderSettings({
    lookNeonFrame,
    trueColour: false,
    reducedEffects: false,
    lookOutput: true,
    bloom: 'auto',
    aa: 'auto',
  }), enabled);
  await waitFrames(page, 5);
}

async function captureDataUrl(page) {
  return page.evaluate(() => window.stageforgeProbe.redrawAndCapture());
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
    accessors: (json.accessors ?? []).map((a) => [a.componentType, a.count, a.type, a.min, a.max]),
  };
}

function mvrFingerprint(bytes) {
  const archive = unzipSync(new Uint8Array(bytes));
  return Object.fromEntries(Object.entries(archive).sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) => [name, sha256(data)]));
}

test('Sprint 23B: neon architecture visuals, accessibility, exports, lifecycle and repeated budgets', async ({ page }) => {
  test.setTimeout(360_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.graphicsProbe)).toBe('function');
  await playSynthDemo(page);
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.evaluate(() => {
    const p = window.stageforgeProbe;
    p.patchShowState({
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
    });
  });
  await waitFrames(page, 8);

  // Fixed seed/cameras: localized deltas must show a restrained, recognizable architectural addition.
  const views = [
    { name: 'foh', pos: [0, 6.2, 24.5], target: [0, 5.35, -0.6], region: [0.18, 0.12, 0.82, 0.88] },
    { name: 'deck-close', pos: [7.2, 2.4, 10.5], target: [0, 1.1, 0], region: [0.02, 0.18, 0.98, 0.95] },
    { name: 'wide', pos: [-16, 9.5, 31], target: [0, 4.8, 0], region: [0.08, 0.10, 0.92, 0.90] },
  ];
  const visual = await page.evaluate(async (viewDefs) => {
    const p = window.stageforgeProbe;
    const decode = (url) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
        resolve({ image: img, pixels: ctx.getImageData(0, 0, img.width, img.height) });
      };
      img.onerror = reject; img.src = url;
    });
    const compare = (a, b, region) => {
      const [rx0, ry0, rx1, ry1] = region;
      const x0 = Math.floor(a.width * rx0), x1 = Math.ceil(a.width * rx1);
      const y0 = Math.floor(a.height * ry0), y1 = Math.ceil(a.height * ry1);
      let changed = 0, large = 0, sum = 0, count = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * a.width + x) * 4;
        const d = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / (3 * 255);
        if (d > 1 / 255) changed++;
        if (d > 0.18) large++;
        sum += d; count++;
      }
      return { changedFraction: changed / count, largeFraction: large / count, meanDelta: sum / count };
    };
    const out = [];
    for (const view of viewDefs) {
      p.setCameraPose(view.pos, view.target);
      p.setRenderSettings({ lookNeonFrame: false, trueColour: false, reducedEffects: false });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const off = await decode(p.redrawAndCapture());
      p.setRenderSettings({ lookNeonFrame: true, trueColour: false, reducedEffects: false });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const on = await decode(p.redrawAndCapture());
      const canvas = document.createElement('canvas');
      canvas.width = 960; canvas.height = 292;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#05070b'; ctx.fillRect(0, 0, 960, 292);
      ctx.drawImage(off.image, 0, 22, 480, 270); ctx.drawImage(on.image, 480, 22, 480, 270);
      ctx.fillStyle = '#e5e7eb'; ctx.font = '600 14px sans-serif';
      ctx.fillText('Before — framing off', 10, 16); ctx.fillText('After — static framing on', 490, 16);
      out.push({ name: view.name, metrics: compare(off.pixels, on.pixels, view.region), dataUrl: canvas.toDataURL('image/webp', 0.80) });
    }
    return out;
  }, views);
  console.log('[SPRINT23B_LOCALIZED_LOOK]', JSON.stringify(visual.map(({ name, metrics }) => ({ name, ...metrics }))));
  for (const result of visual) {
    expect(result.metrics.changedFraction).toBeGreaterThan(0.0004);
    expect(result.metrics.largeFraction).toBeLessThan(0.12);
    expect(result.metrics.meanDelta).toBeLessThan(0.045);
  }
  if (process.env.STAGEFORGE_UPDATE_LOOK_REFS === '1') {
    const dir = join(process.cwd(), 'docs', 'looks');
    await mkdir(dir, { recursive: true });
    for (const reference of visual) {
      await writeFile(join(dir, `sprint23-b-${reference.name}-before-after.webp`), Buffer.from(reference.dataUrl.split(',')[1], 'base64'));
    }
  }

  // Blackout hides the batch. True colour releases it. Reduced effects and reduced motion retain static framing.
  await settleLook(page, true);
  let probe = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(probe.neonFrame.active).toBe(true);
  expect(probe.neonFrame.addedDraws).toBe(1);
  expect(probe.neonFrame.instanceCount).toBeLessThanOrEqual(128);
  expect(probe.resources.neonFrameExtraBufferBytes).toBeLessThanOrEqual(0.10 * 1024 * 1024);
  expect(probe.resources.sprint23ExtraGpuBytes).toBeLessThanOrEqual(0.11 * 1024 * 1024);
  const activePasses = probe.activePasses;

  await page.evaluate(() => window.stageforgeProbe.patchShowState({ blackout: true }));
  await waitFrames(page, 3);
  expect((await page.evaluate(() => window.stageforgeProbe.graphicsProbe())).neonFrame.suppressedReason).toBe('blackout');
  await page.evaluate(() => window.stageforgeProbe.patchShowState({ blackout: false }));
  await page.evaluate(() => window.stageforgeProbe.patchShowState({ masterDimmer: 0 }));
  await waitFrames(page, 3);
  expect((await page.evaluate(() => window.stageforgeProbe.graphicsProbe())).neonFrame.suppressedReason).toBe('master-dimmer');
  await page.evaluate(() => window.stageforgeProbe.patchShowState({ masterDimmer: 1 }));
  await waitFrames(page, 3);
  expect((await page.evaluate(() => window.stageforgeProbe.graphicsProbe())).neonFrame.active).toBe(true);
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ lookNeonFrame: true, trueColour: true }));
  await waitFrames(page, 3);
  probe = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(probe.neonFrame.allocated).toBe(false);
  expect(probe.neonFrame.suppressedReason).toBe('true-colour');
  expect(probe.activePasses).toEqual(['RenderPass', 'OutputPass']);
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ lookNeonFrame: true, trueColour: false, reducedEffects: true }));
  await waitFrames(page, 3);
  expect((await page.evaluate(() => window.stageforgeProbe.graphicsProbe())).neonFrame.active).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await waitFrames(page, 3);
  expect((await page.evaluate(() => window.stageforgeProbe.graphicsProbe())).neonFrame.active).toBe(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect((await page.evaluate(() => window.stageforgeProbe.graphicsProbe())).activePasses).toEqual(activePasses);

  await page.getByTestId('display-settings-toggle').click();
  const neonCheckbox = page.getByTestId('render-neon-frame-checkbox');
  await expect(neonCheckbox).toBeVisible();
  await expect(neonCheckbox).toBeChecked();
  await neonCheckbox.focus();
  await neonCheckbox.press('Space');
  await expect(neonCheckbox).not.toBeChecked();
  await neonCheckbox.press('Space');
  await expect(neonCheckbox).toBeChecked();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('stageforge.render.v1')).lookNeonFrame)).toBe(true);
  await page.keyboard.press('Escape');

  // Near-eye attenuation and close-up aliasing: the decorative batch must not fill the view.
  const nearEye = await page.evaluate(async () => {
    const p = window.stageforgeProbe;
    const pixels = async (enabled) => {
      p.setRenderSettings({ lookNeonFrame: enabled, trueColour: false, reducedEffects: false, bloom: 'off' });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const img = new Image(); img.src = p.redrawAndCapture(); await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, c.width, c.height);
    };
    p.setCameraPose([0, 1.72, 5.57], [0, 1.7, 0]);
    const off = await pixels(false), on = await pixels(true);
    let changed = 0, strong = 0;
    for (let i = 0; i < off.data.length; i += 4) {
      const d = Math.max(Math.abs(off.data[i] - on.data[i]), Math.abs(off.data[i + 1] - on.data[i + 1]), Math.abs(off.data[i + 2] - on.data[i + 2]));
      if (d > 2) changed++;
      if (d > 96) strong++;
    }
    const count = off.width * off.height;
    return { changedFraction: changed / count, strongFraction: strong / count };
  });
  console.log('[SPRINT23B_NEAR_EYE]', JSON.stringify(nearEye));
  expect(nearEye.strongFraction).toBeLessThan(0.08);
  expect(nearEye.changedFraction).toBeLessThan(0.35);

  // Batching is independent, and toggle/rebuild/resize/context restore returns to the same bounded resource state.
  await page.evaluate(() => {
    window.stageforgeProbe.setBatching(false);
    window.stageforgeProbe.setRenderSettings({ lookNeonFrame: true, trueColour: false, reducedEffects: false, bloom: 'auto' });
  });
  await waitFrames(page, 3);
  const unbatchedNeon = await page.evaluate(() => window.stageforgeProbe.graphicsProbe().neonFrame);
  await page.evaluate(() => window.stageforgeProbe.setBatching(true));
  await page.setViewportSize({ width: 1111, height: 703 });
  await page.evaluate(() => window.stageforgeProbe.rebuildRig());
  await page.evaluate(() => window.stageforgeProbe.simulateContextLoss(true));
  await page.evaluate(() => window.stageforgeProbe.simulateContextLoss(false));
  await waitFrames(page, 6);
  const restoredNeon = await page.evaluate(() => window.stageforgeProbe.graphicsProbe().neonFrame);
  expect(restoredNeon.instanceCount).toBe(unbatchedNeon.instanceCount);
  expect(restoredNeon.extraBufferBytes).toBe(unbatchedNeon.extraBufferBytes);
  expect(restoredNeon.addedDraws).toBe(1);

  // Actual UI entry points: GLB, DXF, MVR and paperwork remain invariant with the renderer-only batch.
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  let files = page.getByRole('dialog', { name: 'Show files' });
  await files.getByLabel('Open show file').setInputFiles(authoredShow);
  await expect(files).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.graphicsProbe().neonFrame.deckInstances)).toBeGreaterThan(0);
  await page.evaluate(() => window.stageforgeProbe.patchShowState({ blackout: false, masterDimmer: 1, primaryColor: '#eaa64e', accentColor: '#6fbbff' }));
  await settleLook(page, false);
  const offExports = await actualExports(page);
  await settleLook(page, true);
  const onExports = await actualExports(page);
  expect(glbFingerprint(onExports.glb)).toEqual(glbFingerprint(offExports.glb));
  expect(JSON.stringify(glbFingerprint(onExports.glb))).not.toContain('Neon');
  expect(sha256(onExports.dxf)).toBe(sha256(offExports.dxf));
  expect(mvrFingerprint(onExports.mvr)).toEqual(mvrFingerprint(offExports.mvr));
  expect(sha256(onExports.paperwork)).toBe(sha256(offExports.paperwork));
  expect(onExports.paperwork.toString('utf8')).not.toContain('Neon');
  probe = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(probe.neonFrame.deckInstances).toBeGreaterThan(0);
  expect(probe.neonFrame.screenInstances).toBeGreaterThanOrEqual(8);

  // The effect is static: after the single enable transition, irregular final post-bloom samples do not flash again.
  const safety = await page.evaluate(() => {
    const p = window.stageforgeProbe;
    const dts = [17, 31, 19, 43, 23, 37, 29, 41, 17, 47, 23, 31, 19, 53, 17, 37, 29, 41, 23, 43, 17, 31, 29, 47, 19, 37, 23, 41, 31, 29];
    p.setRenderSettings({ lookNeonFrame: false, trueColour: false, reducedEffects: false, bloom: 'auto' });
    const grids = [p.stepAndReadLuminance(220).grid];
    p.setRenderSettings({ lookNeonFrame: true, trueColour: false, reducedEffects: false, bloom: 'auto' });
    for (const dt of dts) grids.push(p.stepAndReadLuminance(dt).grid);
    let transitions = 0, maxAffected = 0;
    for (let n = 1; n < grids.length; n++) {
      let affected = 0;
      for (let i = 0; i < grids[n].cells.length; i++) {
        if (Math.abs(grids[n].cells[i].y - grids[n - 1].cells[i].y) >= 0.10) affected++;
      }
      const fraction = affected / grids[n].cells.length;
      maxAffected = Math.max(maxAffected, fraction);
      if (fraction >= 0.25) transitions++;
    }
    return { transitions, maxAffected };
  });
  console.log('[SPRINT23B_FINAL_BLOOM_SAFETY]', JSON.stringify(safety));
  expect(safety.transitions).toBeLessThanOrEqual(1);
  expect(safety.maxAffected).toBeLessThan(0.55);

  const measurePairs = async (pairs, warmupFrames, sampleFrames) => {
    const out = [];
    for (let i = 0; i < pairs; i++) for (const enabled of [false, true]) {
      await settleLook(page, enabled);
      const report = await page.evaluate(
        ({ warmupFrames: warm, sampleFrames: samples }) => window.stageforgeProbe.measureFrames({ warmupFrames: warm, sampleFrames: samples, gpu: true }),
        { warmupFrames, sampleFrames },
      );
      out.push({ enabled, report, probe: await page.evaluate(() => window.stageforgeProbe.graphicsProbe()) });
    }
    return out;
  };
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summarize = (pairs) => ({
    offP50: pairs.filter((x) => !x.enabled).map((x) => x.report.cpuTotalMs.p50),
    onP50: pairs.filter((x) => x.enabled).map((x) => x.report.cpuTotalMs.p50),
    offP95: pairs.filter((x) => !x.enabled).map((x) => x.report.cpuTotalMs.p95),
    onP95: pairs.filter((x) => x.enabled).map((x) => x.report.cpuTotalMs.p95),
    offP99: pairs.filter((x) => !x.enabled).map((x) => x.report.cpuTotalMs.p99),
    onP99: pairs.filter((x) => x.enabled).map((x) => x.report.cpuTotalMs.p99),
    gpuOffP50: pairs.filter((x) => !x.enabled).map((x) => x.report.gpuMs.p50),
    gpuOnP50: pairs.filter((x) => x.enabled).map((x) => x.report.gpuMs.p50),
  });

  await page.setViewportSize({ width: 1280, height: 720 });
  const laptopPairs = await measurePairs(3, 12, 36);
  const laptop = summarize(laptopPairs);
  laptop.deltaP50 = Number((median(laptop.onP50) - median(laptop.offP50)).toFixed(3));
  laptop.debugRenderer = laptopPairs[0].probe.debugRenderer;

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.setViewportSize({ width: 390, height: 844 });
  const phonePairs = await measurePairs(3, 10, 30);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const phone = summarize(phonePairs);
  phone.deltaP50 = Number((median(phone.onP50) - median(phone.offP50)).toFixed(3));
  phone.debugRenderer = phonePairs[0].probe.debugRenderer;
  console.log('[SPRINT23B_BUDGET]', JSON.stringify({ laptop, phone, measurementResolutionMs: 0.1 }));

  // Profiler percentiles are reported at 0.1 ms; include half a bin in the ceiling assertion.
  expect(laptop.deltaP50).toBeLessThanOrEqual(0.20);
  expect(phone.deltaP50).toBeLessThanOrEqual(0.35);
  expect(laptopPairs.find((x) => x.enabled).probe.stats.calls - laptopPairs.find((x) => !x.enabled).probe.stats.calls).toBeLessThanOrEqual(1);
  expect(phonePairs.find((x) => x.enabled).probe.resources.neonFrameExtraBufferBytes).toBeLessThanOrEqual(0.10 * 1024 * 1024);
});
