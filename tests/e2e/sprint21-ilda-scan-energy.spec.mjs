import { expect, test } from '@playwright/test';

const waitFrames = (page, count = 3) =>
  page.evaluate((n) => new Promise((resolve) => {
    let i = 0;
    const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  }), count);

async function bootArenaIlda(page) {
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.graphicsProbe)).toBe('function');
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Lasers', exact: true }).click();
  await page.getByRole('button', { name: 'Load demo', exact: true }).click();
  await page.evaluate(() => {
    window.stageforgeProbe.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: false,
      masterDimmer: 1,
      laser: {
        enabled: true,
        intensity: 1,
        strobe: 0,
        speed: 0,
        rotation: 0,
        spreadX: 0.72,
        spreadY: 0.72,
      },
      atmo: { hazeLevel: 0.48, smokeOutput: 0, co2Active: false },
    });
  });
  await waitFrames(page, 5);
}

test('Sprint 21: high-tier line replacement, visual/core parity, safety isolation, dense fallback and lifecycle', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' || /THREE\.WebGLProgram/i.test(msg.text())) errors.push(msg.text());
  });

  await page.setViewportSize({ width: 1280, height: 720 });
  await bootArenaIlda(page);

  const result = await page.evaluate(async () => {
    const nextFrames = (count = 3) => new Promise((resolve) => {
      let i = 0;
      const step = () => (++i >= count ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    const decode = (url) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        resolve(context.getImageData(0, 0, canvas.width, canvas.height));
      };
      image.onerror = reject;
      image.src = url;
    });
    const compare = (a, b) => {
      let maxLsb = 0;
      let changed = 0;
      let localized = 0;
      const x0 = Math.floor(a.width * 0.16);
      const x1 = Math.ceil(a.width * 0.84);
      const y0 = Math.floor(a.height * 0.05);
      const y1 = Math.ceil(a.height * 0.72);
      for (let y = 0; y < a.height; y++) {
        for (let x = 0; x < a.width; x++) {
          const i = (y * a.width + x) * 4;
          const d = Math.max(
            Math.abs(a.data[i] - b.data[i]),
            Math.abs(a.data[i + 1] - b.data[i + 1]),
            Math.abs(a.data[i + 2] - b.data[i + 2]),
          );
          maxLsb = Math.max(maxLsb, d);
          if (d >= 3) changed++;
          if (d >= 3 && x >= x0 && x < x1 && y >= y0 && y < y1) localized++;
        }
      }
      return { maxLsb, changed, localized };
    };
    const probe = window.stageforgeProbe;
    const staticXy = new Int16Array([-24000, 0, 0, 22000, 24000, 0, 0, -22000, -24000, 0]);
    const staticRgb = new Uint8Array([
      0, 240, 255, 255, 0, 102, 255, 190, 0, 0, 240, 255, 0, 240, 255,
    ]);
    probe.loadIldaClip({
      name: 'Static scan-energy fixture',
      frames: [{
        name: 'STATIC', company: 'TEST', format: 5, offset: 0, count: 5, litCount: 5,
        litSpanX: 1.47, litSpanY: 1.34, minLitX: -0.73, maxLitX: 0.73, minLitY: -0.67, maxLitY: 0.67,
      }],
      xy: staticXy, rgb: staticRgb, blank: new Uint8Array(5), totalPoints: 5,
      bounds: { minX: -0.73, maxX: 0.73, minY: -0.67, maxY: 0.67, hasLitPoints: true },
      warnings: [],
    });
    probe.stepAndReadLuminance(0);

    probe.setRenderSettings({ ildaScanEnergy: false });
    const lineUrl = probe.redrawAndCapture();
    const lineProbe = probe.graphicsProbe();
    const physicalBefore = JSON.stringify(probe.physicalDmxSnapshot());
    const preflightBefore = JSON.stringify(probe.preflightReport());

    probe.setRenderSettings({ ildaScanEnergy: true });
    const ribbonUrl = probe.redrawAndCapture();
    const ribbonProbe = probe.graphicsProbe();
    const physicalAfter = JSON.stringify(probe.physicalDmxSnapshot());
    const preflightAfter = JSON.stringify(probe.preflightReport());

    probe.setRenderSettings({ ildaScanEnergy: false });
    const restoredUrl = probe.redrawAndCapture();
    const restoredProbe = probe.graphicsProbe();
    const [lineImage, ribbonImage, restoredImage] = await Promise.all([
      decode(lineUrl), decode(ribbonUrl), decode(restoredUrl),
    ]);

    const optionalOff = {
      fallingCo2: false, videoSrgbDecode: false, prismPools: false, ledAngularResponse: false,
      deckSheen: false, crowdLighting: false, litPuffs: false, ildaScanEnergy: false,
    };
    probe.setRenderSettings(optionalOff);
    const isolatedOffMeasure = await probe.measureFrames({ warmupFrames: 6, sampleFrames: 20, gpu: true });
    probe.setRenderSettings({ ildaScanEnergy: true });
    const isolatedOnMeasure = await probe.measureFrames({ warmupFrames: 6, sampleFrames: 20, gpu: true });
    probe.setRenderSettings({
      fallingCo2: true, videoSrgbDecode: true, prismPools: true, ledAngularResponse: true,
      deckSheen: true, crowdLighting: true, litPuffs: true, ildaScanEnergy: true,
    });
    const combinedMeasure = await probe.measureFrames({ warmupFrames: 6, sampleFrames: 20, gpu: true });
    const combinedProbe = probe.graphicsProbe();
    const combinedBytes =
      combinedProbe.resources.prismPoolExtraBufferBytes +
      combinedProbe.resources.deckSheenExtraTextureBytes +
      combinedProbe.resources.litPuffsExtraBufferBytes +
      combinedProbe.resources.ildaScanEnergyExtraBufferBytes;
    probe.setRenderSettings({ ...optionalOff, ildaScanEnergy: true });

    probe.patchShowState({ blackout: true });
    probe.stepAndReadLuminance(0);
    probe.setRenderSettings({ ildaScanEnergy: false });
    const blackoutOffUrl = probe.redrawAndCapture();
    probe.setRenderSettings({ ildaScanEnergy: true });
    const blackoutOnUrl = probe.redrawAndCapture();
    const blackoutProbe = probe.graphicsProbe();
    const [blackoutOff, blackoutOn] = await Promise.all([decode(blackoutOffUrl), decode(blackoutOnUrl)]);

    probe.patchShowState({ blackout: false });
    for (let i = 0; i < 8; i++) {
      probe.setRenderSettings({ ildaScanEnergy: i % 2 === 0 });
      if (i % 4 === 3) probe.rebuildRig();
    }
    probe.setRenderSettings({ ildaScanEnergy: true });
    await nextFrames(4);
    const beforeContext = probe.graphicsProbe();
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const lose = gl?.getExtension?.('WEBGL_lose_context');
    if (lose) {
      const restored = new Promise((resolve) => canvas.addEventListener('webglcontextrestored', resolve, { once: true }));
      lose.loseContext();
      await new Promise((resolve) => setTimeout(resolve, 40));
      lose.restoreContext();
      await restored;
    }
    await nextFrames(4);
    probe.redrawAndCapture();
    const afterContext = probe.graphicsProbe();

    const count = 4000;
    const xy = new Int16Array(count * 2);
    const rgb = new Uint8Array(count * 3);
    const blank = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      xy[i * 2] = -32000 + ((i * 997) % 64000);
      xy[i * 2 + 1] = -28000 + ((i * 577) % 56000);
      rgb[i * 3] = 40 + (i % 216);
      rgb[i * 3 + 1] = 255;
      rgb[i * 3 + 2] = 220;
    }
    probe.loadIldaClip({
      name: 'Dense bounded fixture',
      frames: [{
        name: 'DENSE', company: 'TEST', format: 5, offset: 0, count, litCount: count,
        litSpanX: 1.95, litSpanY: 1.71, minLitX: -0.98, maxLitX: 0.97, minLitY: -0.85, maxLitY: 0.86,
      }],
      xy, rgb, blank, totalPoints: count,
      bounds: { minX: -0.98, maxX: 0.97, minY: -0.85, maxY: 0.86, hasLitPoints: true },
      warnings: [],
    });
    await nextFrames(4);
    probe.redrawAndCapture();
    const denseProbe = probe.graphicsProbe();

    probe.loadIldaClip(null);
    await nextFrames(3);
    const unloaded = probe.graphicsProbe();

    return {
      lineCalls: lineProbe.stats.calls,
      ribbonCalls: ribbonProbe.stats.calls,
      restoredCalls: restoredProbe.stats.calls,
      lineToRibbon: compare(lineImage, ribbonImage),
      lineToRestored: compare(lineImage, restoredImage),
      blackoutParity: compare(blackoutOff, blackoutOn),
      ribbon: ribbonProbe.ilda.scanEnergy,
      blackout: blackoutProbe.ilda.scanEnergy,
      physicalInvariant: physicalBefore === physicalAfter,
      preflightInvariant: preflightBefore === preflightAfter,
      beforeContext: beforeContext.ilda.scanEnergy,
      afterContext: afterContext.ilda.scanEnergy,
      dense: denseProbe.ilda.scanEnergy,
      denseCalls: denseProbe.stats.calls,
      unloadedBytes: unloaded.resources.ildaScanEnergyExtraBufferBytes,
      unloadedSegments: unloaded.ilda.bakedSegments,
      tier: ribbonProbe.tier,
      isolatedOffMeasure,
      isolatedOnMeasure,
      combinedMeasure,
      combinedCalls: combinedProbe.stats.calls,
      combinedBytes,
      lineUrl,
      ribbonUrl,
    };
  });

  await testInfo.attach('arena-ilda-line.png', {
    body: Buffer.from(result.lineUrl.split(',')[1], 'base64'),
    contentType: 'image/png',
  });
  await testInfo.attach('arena-ilda-scan-energy.png', {
    body: Buffer.from(result.ribbonUrl.split(',')[1], 'base64'),
    contentType: 'image/png',
  });
  console.log(`SPRINT21_HIGH ${JSON.stringify({
    lineCalls: result.lineCalls,
    ribbonCalls: result.ribbonCalls,
    visual: result.lineToRibbon,
    restoreMaxLsb: result.lineToRestored.maxLsb,
    blackoutMaxLsb: result.blackoutParity.maxLsb,
    offP50: result.isolatedOffMeasure.cpuTotalMs.p50,
    scanP50: result.isolatedOnMeasure.cpuTotalMs.p50,
    combinedP50: result.combinedMeasure.cpuTotalMs.p50,
    scanGpuP50: result.isolatedOnMeasure.gpuMs.p50,
    combinedBytes: result.combinedBytes,
    ilda: result.ribbon,
  })}`);
  expect(result.tier).toBe('high');
  expect(result.ribbon.active).toBe(true);
  expect(result.ribbon.ribbonProjectors).toBeGreaterThan(0);
  expect(result.ribbon.fallbackProjectors).toBe(0);
  expect(result.ribbon.capacityTriangles).toBeLessThanOrEqual(16_000);
  expect(result.ribbon.extraBufferBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(result.ribbonCalls).toBe(result.lineCalls);
  expect(result.restoredCalls).toBe(result.lineCalls);
  expect(result.lineToRibbon.localized).toBeGreaterThan(40);
  expect(result.lineToRibbon.maxLsb).toBeGreaterThan(3);
  expect(result.lineToRestored.maxLsb).toBeLessThanOrEqual(1);
  expect(result.blackoutParity.maxLsb).toBeLessThanOrEqual(1);
  expect(result.blackout.active).toBe(false);
  expect(result.physicalInvariant).toBe(true);
  expect(result.preflightInvariant).toBe(true);
  expect(result.beforeContext.active).toBe(true);
  expect(result.afterContext.active).toBe(true);
  expect(result.dense.active).toBe(false);
  expect(result.dense.fallbackProjectors).toBeGreaterThan(0);
  expect(result.dense.capacityTriangles).toBeLessThanOrEqual(16_000);
  expect(result.dense.extraBufferBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(result.denseCalls).toBeLessThanOrEqual(result.lineCalls);
  expect(result.combinedCalls - result.lineCalls).toBeLessThanOrEqual(1);
  expect(result.combinedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(result.unloadedBytes).toBe(0);
  expect(result.unloadedSegments).toBe(0);
  expect(errors).toEqual([]);
});

test.describe('Sprint 21 low tier and combined optional ceiling', () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });

  test('populates ribbons within low budgets, persists the mobile control, and measures the combined configuration', async ({ page }) => {
    test.setTimeout(180_000);
    await page.addInitScript(() => {
      localStorage.setItem('stageforge.render.v1', JSON.stringify({ ildaScanEnergy: true }));
    });
    await bootArenaIlda(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    const enabled = await page.evaluate(async () => {
      const probe = window.stageforgeProbe;
      probe.redrawAndCapture();
      const initial = probe.graphicsProbe();

      const optionalOff = {
        fallingCo2: false,
        videoSrgbDecode: false,
        prismPools: false,
        ledAngularResponse: false,
        deckSheen: false,
        crowdLighting: false,
        litPuffs: false,
        ildaScanEnergy: false,
      };
      probe.setRenderSettings(optionalOff);
      const offMeasure = await probe.measureFrames({ warmupFrames: 4, sampleFrames: 12, gpu: false });
      const offProbe = probe.graphicsProbe();

      probe.setRenderSettings({ ildaScanEnergy: true });
      const scanMeasure = await probe.measureFrames({ warmupFrames: 4, sampleFrames: 12, gpu: true });
      const scanProbe = probe.graphicsProbe();

      probe.setRenderSettings({
        fallingCo2: true,
        videoSrgbDecode: true,
        prismPools: true,
        ledAngularResponse: true,
        deckSheen: true,
        crowdLighting: true,
        litPuffs: true,
        ildaScanEnergy: true,
      });
      const onMeasure = await probe.measureFrames({ warmupFrames: 4, sampleFrames: 12, gpu: false });
      probe.redrawAndCapture();
      const onProbe = probe.graphicsProbe();
      const combinedBytes =
        onProbe.resources.prismPoolExtraBufferBytes +
        onProbe.resources.deckSheenExtraTextureBytes +
        onProbe.resources.litPuffsExtraBufferBytes +
        onProbe.resources.ildaScanEnergyExtraBufferBytes;
      return { initial, offProbe, scanProbe, onProbe, offMeasure, scanMeasure, onMeasure, combinedBytes };
    });

    expect(enabled.initial.tier).toBe('low');
    expect(enabled.initial.settings.ildaScanEnergy).toBe(true);
    expect(enabled.initial.ilda.scanEnergy.active).toBe(true);
    expect(enabled.initial.ilda.scanEnergy.capacityTriangles).toBeLessThanOrEqual(4_000);
    expect(enabled.initial.ilda.scanEnergy.extraBufferBytes).toBeLessThanOrEqual(512 * 1024);
    expect(enabled.scanProbe.ilda.scanEnergy.active).toBe(true);
    expect(enabled.scanProbe.stats.calls).toBe(enabled.offProbe.stats.calls);
    expect(enabled.onProbe.ilda.scanEnergy.active).toBe(true);
    expect(enabled.onProbe.ilda.scanEnergy.fallbackProjectors).toBe(0);
    expect(enabled.onProbe.stats.calls - enabled.offProbe.stats.calls).toBeLessThanOrEqual(1);
    expect(enabled.combinedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(enabled.onProbe.fullRateStrobePreview).toBe(false);
    expect(enabled.onProbe.previewFlashLimiting).toBe(true);

    await page.getByRole('button', { name: 'Display and safety settings' }).click();
    const checkbox = page.getByTestId('render-ilda-scan-energy-checkbox');
    await expect(checkbox).toBeChecked();
    const box = await checkbox.locator('..').boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    console.log(`SPRINT21_LOW_COMBINED ${JSON.stringify({
      offP50: enabled.offMeasure.cpuTotalMs.p50,
      scanP50: enabled.scanMeasure.cpuTotalMs.p50,
      onP50: enabled.onMeasure.cpuTotalMs.p50,
      scanGpuP50: enabled.scanMeasure.gpuMs.p50,
      callsOff: enabled.offProbe.stats.calls,
      callsOn: enabled.onProbe.stats.calls,
      combinedBytes: enabled.combinedBytes,
      ilda: enabled.onProbe.ilda.scanEnergy,
    })}`);
  });
});
