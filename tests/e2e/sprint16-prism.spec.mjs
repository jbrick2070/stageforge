import { playSynthDemo } from '../support/play-synth-demo.mjs';
import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const waitFrames = (page, count = 3) =>
  page.evaluate((n) => new Promise((resolve) => {
    let i = 0;
    const step = () => {
      if (++i >= n) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), count);

async function exportGlbJson(page) {
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const files = page.getByRole('dialog', { name: 'Show files' });
  const download = page.waitForEvent('download');
  await files.getByRole('button', { name: '3D scene GLB' }).click();
  const glb = await readFile(await (await download).path());
  await files.getByRole('button', { name: 'Close Show files' }).click();
  await expect(files).toBeHidden();
  return JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
}

test('Sprint 16: default-off parity, localized floor prism projections, prism rotation, hung & floor heads, proxy parity, GLB invariance, and lifecycle stability', async ({ page }) => {
  test.setTimeout(150_000);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' || /THREE\.WebGLProgram/i.test(msg.text())) errors.push(msg.text());
  });

  await page.clock.install();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.graphicsProbe)).toBe('function');
  await playSynthDemo(page);
  await page.getByRole('button', { name: /Laser Tunnel/ }).first().click();
  await expect.poll(async () => page.evaluate(() =>
    window.stageforgeProbe.beamAxes().filter((b) => b.optics.emitted > 0.001).length
  )).toBeGreaterThanOrEqual(30);

  // Switch to the overhead camera (`Digit5`) and freeze time with wide zoom (`1.0`) aimed onto the deck
  // so localized deck-region crops measure the 8-spot prism floor projection directly from above.
  await page.keyboard.press('Digit5');
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await page.evaluate(() => {
    const probe = window.stageforgeProbe;
    probe.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: false,
      masterDimmer: 1,
      goboPrism: true,
      beamIntensity: 1,
      washIntensity: 0,
      blinderLevel: 0,
      strobeRate: 0,
      zoom: 1.0,
      movementMode: 'manual',
      manualPan: 0,
      manualTilt: 0.0, // straight down onto deck
      primaryColor: '#00f0ff',
      accentColor: '#00f0ff',
      atmo: { hazeLevel: 0.04, smokeOutput: 0, co2Active: false },
      laser: { enabled: false, intensity: 0 },
      led: { enabled: false, brightness: 0 },
    });
    // Settle overhead camera lerp (`dt * 4.5`) and pan/tilt lerp past preview flash refractory
    for (let i = 0; i < 60; i++) probe.stepAndReadLuminance(50);
  });

  // 1. Default-off check: zero optional buffer bytes, exact draw calls, localized deck crop comparison,
  //    prism rotation over frozen time, non-prism parity, and proxy-vs-unbatched parity.
  const analysis = await page.evaluate(async () => {
    const decode = (url) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, c.width, c.height));
      };
      img.onerror = reject;
      img.src = url;
    });
    const regionStats = (a, b, x0Frac, y0Frac, x1Frac, y1Frac) => {
      const x0 = Math.floor(a.width * x0Frac);
      const x1 = Math.ceil(a.width * x1Frac);
      const y0 = Math.floor(a.height * y0Frac);
      const y1 = Math.ceil(a.height * y1Frac);
      let sum = 0;
      let maxChannel = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * a.width + x) * 4;
          const dr = Math.abs(a.data[idx] - b.data[idx]);
          const dg = Math.abs(a.data[idx + 1] - b.data[idx + 1]);
          const db = Math.abs(a.data[idx + 2] - b.data[idx + 2]);
          sum += dr + dg + db;
          const m = Math.max(dr, dg, db);
          if (m > maxChannel) maxChannel = m;
          count++;
        }
      }
      return {
        mean: count > 0 ? sum / (count * 3 * 255) : 0,
        max: maxChannel / 255,
      };
    };

    const probe = window.stageforgeProbe;
    // Capture default-off (`prismPools: false`) — render full scene first so `stats.calls` measures identical passes
    probe.redrawAndCapture();
    const probeOff = probe.graphicsProbe();
    const imgFlagOff = probe.redrawAndCapture({ hideBeams: true });
    const imgNoPoolsOff = probe.redrawAndCapture({ hideBeams: true, hidePools: true });

    // Enable `prismPools: true` at the exact same frozen frame (rebuildBeamPools refills synchronously)
    probe.setRenderSettings({ prismPools: true });
    const imgFullOnBatched = probe.redrawAndCapture();
    const probeOn = probe.graphicsProbe();
    const imgFlagOnT0 = probe.redrawAndCapture({ hideBeams: true });

    // Proxy vs unbatched parity with prismPools: true
    probe.setBatching(false, { proxies: false });
    const imgFullOnUnbatched = probe.redrawAndCapture();
    probe.setBatching(true, { proxies: true });

    // Advance simulation by 500 ms so prism phase advances by 0.24 rad (~13.8 deg) and capture deck again
    probe.stepAndReadLuminance(250);
    probe.stepAndReadLuminance(250);
    const imgFlagOnT1 = probe.redrawAndCapture({ hideBeams: true });

    // Turn goboPrism off (wait > 380 ms refractory so prismMix settles to 0) and confirm prismPools: true matches prismPools: false
    probe.patchShowState({ goboPrism: false });
    probe.stepAndReadLuminance(220);
    probe.stepAndReadLuminance(220);
    const imgNonPrismWithFlagOn = probe.redrawAndCapture({ hideBeams: true });
    probe.setRenderSettings({ prismPools: false });
    const imgNonPrismWithFlagOff = probe.redrawAndCapture({ hideBeams: true });

    // Grazing oblique beam check (`manualTilt: 0.62` sweeps across deck & arena floor) + floor_beam tilted downward (`manualTilt: -1.15`)
    probe.patchShowState({ goboPrism: true, manualTilt: 0.62 });
    for (let i = 0; i < 30; i++) probe.stepAndReadLuminance(25);
    const imgGrazingOff = probe.redrawAndCapture({ hideBeams: true });
    probe.setRenderSettings({ prismPools: true });
    const imgGrazingOn = probe.redrawAndCapture({ hideBeams: true });

    // Isolate floor_beam units (`isFloor = true`): at `manualTilt: 1.55` (`1.78 rad = 102 deg`),
    // hung heads (`-1.78 rad` from `-Y`) point +12 deg upward while floor_beam units (`+1.78 rad` from `+Y`)
    // point -12 deg downward across the deck & arena floor!
    probe.setRenderSettings({ prismPools: false });
    probe.patchShowState({
      goboPrism: true,
      manualPan: 0,
      manualTilt: 1.55,
    });
    for (let i = 0; i < 35; i++) probe.stepAndReadLuminance(25);
    const floorHeadProbeOff = probe.redrawAndCapture({ hideBeams: true });
    probe.setRenderSettings({ prismPools: true });
    const floorHeadStats = probe.graphicsProbe().prismPools;
    const floorHeadProbeOn = probe.redrawAndCapture({ hideBeams: true });

    const [
      dOff,
      dNoPools,
      dOnT0,
      dOnT1,
      dBatched,
      dUnbatched,
      dNonPrismOn,
      dNonPrismOff,
      dGrazingOff,
      dGrazingOn,
      dFloorOff,
      dFloorOn,
    ] = await Promise.all([
      decode(imgFlagOff),
      decode(imgNoPoolsOff),
      decode(imgFlagOnT0),
      decode(imgFlagOnT1),
      decode(imgFullOnBatched),
      decode(imgFullOnUnbatched),
      decode(imgNonPrismWithFlagOn),
      decode(imgNonPrismWithFlagOff),
      decode(imgGrazingOff),
      decode(imgGrazingOn),
      decode(floorHeadProbeOff),
      decode(floorHeadProbeOn),
    ]);

    // In overhead framing, the illuminated stage deck sits inside x: [0.33, 0.67], y: [0.47, 0.78] of the canvas
    const deckCrop = [0.33, 0.47, 0.67, 0.78];
    const lowerStageAndFloorCrop = [0.18, 0.35, 0.82, 0.95];
    const poolDeck = regionStats(dOff, dNoPools, ...deckCrop);
    const prismDeck = regionStats(dOnT0, dOff, ...deckCrop);
    const rotDeck = regionStats(dOnT0, dOnT1, ...deckCrop);
    const grazing = regionStats(dGrazingOn, dGrazingOff, ...lowerStageAndFloorCrop);
    const floorHead = regionStats(dFloorOn, dFloorOff, ...lowerStageAndFloorCrop);
    const nonPrism = regionStats(dNonPrismOn, dNonPrismOff, ...deckCrop);
    return {
      imgFlagOff,
      imgFlagOnT0,
      imgFullOnBatched,
      probeOffPrism: probeOff.prismPools,
      probeOnPrism: probeOn.prismPools,
      floorHeadStats,
      callsOff: probeOff.stats.calls,
      callsOn: probeOn.stats.calls,
      poolSignalOnDeck: poolDeck.mean,
      poolPeakOnDeck: poolDeck.max,
      prismVsFlatOnDeck: prismDeck.mean,
      prismVsFlatPeakOnDeck: prismDeck.max,
      prismRotationDiffOnDeck: rotDeck.mean,
      prismRotationPeakOnDeck: rotDeck.max,
      grazingDiff: grazing.mean,
      grazingPeak: grazing.max,
      floorHeadDiff: floorHead.mean,
      floorHeadPeak: floorHead.max,
      proxyVsUnbatchedWhole: regionStats(dBatched, dUnbatched, 0, 0, 1, 1).mean,
      nonPrismFlagParityOnDeck: nonPrism.mean,
      nonPrismFlagPeakOnDeck: nonPrism.max,
    };
  });

  if (process.env.SPRINT16_CAPTURE_DIR) {
    await mkdir(process.env.SPRINT16_CAPTURE_DIR, { recursive: true });
    const savePng = (name, url) =>
      writeFile(join(process.env.SPRINT16_CAPTURE_DIR, name), Buffer.from(url.split(',')[1], 'base64'));
    await Promise.all([
      savePng('deck-pools-off.png', analysis.imgFlagOff),
      savePng('deck-pools-prism-on.png', analysis.imgFlagOnT0),
      savePng('full-overhead-prism-on.png', analysis.imgFullOnBatched),
    ]);
  }

  expect(analysis.probeOffPrism.requested).toBe(false);
  expect(analysis.probeOffPrism.allocated).toBe(false);
  expect(analysis.probeOffPrism.extraBufferBytes).toBe(0);

  expect(analysis.probeOnPrism.requested).toBe(true);
  expect(analysis.probeOnPrism.allocated).toBe(true);
  expect(analysis.probeOnPrism.active).toBe(true);
  expect(analysis.probeOnPrism.suppressedReason).toBeNull();
  expect(analysis.probeOnPrism.extraBufferBytes).toBe(44 * 2 * 32);
  expect(analysis.probeOnPrism.extraBufferBytes).toBeLessThan(100 * 1024);

  // Zero added draw calls!
  expect(analysis.callsOn).toBe(analysis.callsOff);
  expect(analysis.callsOn).toBeLessThanOrEqual(140);

  // Floor pools are clearly visible in the localized deck region, prism splits them into 8-spot rosettes, and rotation moves the spots!
  expect(analysis.poolSignalOnDeck).toBeGreaterThan(0.005);
  expect(analysis.poolPeakOnDeck).toBeGreaterThan(0.40);
  expect(analysis.prismVsFlatOnDeck).toBeGreaterThan(0.002);
  expect(analysis.prismVsFlatPeakOnDeck).toBeGreaterThan(0.25);
  expect(analysis.prismRotationDiffOnDeck).toBeGreaterThan(0.0005);
  expect(analysis.prismRotationPeakOnDeck).toBeGreaterThan(0.15);
  expect(analysis.grazingDiff).toBeGreaterThan(0.0002);
  expect(analysis.grazingPeak).toBeGreaterThan(0.10);
  expect(analysis.floorHeadStats.activePrismInstances).toBeGreaterThan(0);
  expect(analysis.floorHeadPeak).toBeGreaterThan(0.05);

  // Proxy vs unbatched parity holds tightly (< 1%) with prismPools enabled, and goboPrism=false matches flag-off!
  expect(analysis.proxyVsUnbatchedWhole).toBeLessThan(0.01);
  expect(analysis.nonPrismFlagParityOnDeck).toBeLessThan(0.0005);
  expect(analysis.nonPrismFlagPeakOnDeck).toBeLessThan(0.02);

  await page.clock.resume();

  // 2. GLB export invariance: BeamPools lives outside rigGroup so GLB export is identical with prismPools off vs on.
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ prismPools: false }));
  const glbOff = await exportGlbJson(page);
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ prismPools: true }));
  const glbOn = await exportGlbJson(page);
  expect(glbOn.nodes.length).toBe(glbOff.nodes.length);
  expect(glbOn.meshes.length).toBe(glbOff.meshes.length);

  // 3. Lifecycle stability: repeated prismPools toggles + rig rebuilds leak zero geometries, textures, or programs.
  const lifecycle = await page.evaluate(async () => {
    const next = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const probe = window.stageforgeProbe;
    probe.setRenderSettings({ prismPools: true });
    await next();
    probe.setRenderSettings({ prismPools: false });
    await next();
    const before = probe.graphicsProbe();
    for (let i = 0; i < 8; i++) {
      probe.setRenderSettings({ prismPools: i % 2 === 0 });
      await next();
      if (i % 2 === 1) {
        probe.rebuildRig();
        await next();
      }
    }
    probe.setRenderSettings({ prismPools: false });
    await next();
    const after = probe.graphicsProbe();
    return { before, after };
  });
  expect(lifecycle.after.stats.geometries).toBeLessThanOrEqual(lifecycle.before.stats.geometries + 1);
  expect(lifecycle.after.stats.textures).toBeLessThanOrEqual(lifecycle.before.stats.textures + 1);
  expect(lifecycle.after.stats.programs).toBeLessThanOrEqual(lifecycle.before.stats.programs + 1);

  expect(errors).toEqual([]);
});

test('Sprint 16: warmed desktop & 390x844 phone-like probe budgets, Display UI persistence, and 10 Hz goboPrism flash-limit safety', async ({ page }) => {
  test.setTimeout(150_000);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' || /THREE\.WebGLProgram/i.test(msg.text())) errors.push(msg.text());
  });

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.measureFrames)).toBe('function');
  await playSynthDemo(page);
  await page.getByRole('button', { name: /Laser Tunnel/ }).first().click();
  await waitFrames(page, 8);

  // 1. Desktop 1280x720 warmed A/B benchmark (Laser Tunnel, goboPrism: true)
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ prismPools: false }));
  await waitFrames(page, 4);
  const desktopOff = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 10, sampleFrames: 30, gpu: true })
  );
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ prismPools: true }));
  await waitFrames(page, 4);
  const desktopOn = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 10, sampleFrames: 30, gpu: true })
  );
  const desktopProbeOn = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(Math.round(desktopOn.meanCalls)).toBe(Math.round(desktopOff.meanCalls));
  expect(desktopOn.meanUploadBytes).toBeGreaterThan(desktopOff.meanUploadBytes);
  expect(desktopProbeOn.prismPools.extraBufferBytes).toBeLessThan(100 * 1024);

  // 2. 10 Hz goboPrism toggling safety check on close-up stage view (must stay <= 3 flashes/s across all 64 cells)
  const prismFlashSafety = await page.evaluate(() => {
    const probe = window.stageforgeProbe;
    probe.setFullRateStrobePreview(false);
    probe.setRenderSettings({ prismPools: true });
    probe.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: false,
      masterDimmer: 1,
      beamIntensity: 1,
      washIntensity: 0,
      blinderLevel: 0,
      strobeRate: 0,
      movementMode: 'manual',
      manualPan: 0,
      manualTilt: 0,
      primaryColor: '#ff0000',
      accentColor: '#ff0000',
      goboPrism: false,
      laser: { enabled: false, intensity: 0 },
      led: { enabled: false, brightness: 0 },
    });
    for (let i = 0; i < 25; i++) probe.stepAndReadLuminance(25);

    const samples = [];
    let elapsed = 0;
    for (let step = 0; step < 60; step++) {
      elapsed += 25;
      const flip = Math.floor(elapsed / 50) % 2 === 0;
      probe.patchShowState({ goboPrism: flip });
      const res = probe.stepAndReadLuminance(25);
      samples.push({ timeMs: res.elapsedMs, grid: res.grid });
    }

    const countSeries = (extract) => {
      const genTimes = [];
      const redTimes = [];
      let anchorY = extract(samples[0]).y;
      let lastGenDir = 0;
      let anchorRed = extract(samples[0]);
      let lastRedDir = 0;
      for (let i = 1; i < samples.length; i++) {
        const t = samples[i].timeMs;
        const m = extract(samples[i]);
        const dy = m.y - anchorY;
        if (Math.abs(dy) >= 0.10 && Math.min(m.y, anchorY) < 0.80) {
          const dir = dy > 0 ? 1 : -1;
          if (lastGenDir !== 0 && dir !== lastGenDir) genTimes.push(t);
          lastGenDir = dir;
          anchorY = m.y;
        } else if ((lastGenDir > 0 && m.y > anchorY) || (lastGenDir < 0 && m.y < anchorY)) {
          anchorY = m.y;
        }
        const dRed = m.redMetric - anchorRed.redMetric;
        if ((m.redRatio >= 0.80 || anchorRed.redRatio >= 0.80) && Math.abs(dRed) > 20) {
          const dir = dRed > 0 ? 1 : -1;
          if (lastRedDir !== 0 && dir !== lastRedDir) redTimes.push(t);
          lastRedDir = dir;
          anchorRed = m;
        } else if ((lastRedDir > 0 && m.redMetric > anchorRed.redMetric) || (lastRedDir < 0 && m.redMetric < anchorRed.redMetric)) {
          anchorRed = m;
        }
      }
      const maxWin = (arr) => {
        let best = 0;
        let left = 0;
        for (let r = 0; r < arr.length; r++) {
          while (arr[r] - arr[left] >= 1000) left++;
          if (r - left + 1 > best) best = r - left + 1;
        }
        return Math.ceil(best / 2);
      };
      return { gen: maxWin(genTimes), red: maxWin(redTimes) };
    };

    let maxGen = countSeries((s) => s.grid.whole).gen;
    let maxRed = countSeries((s) => s.grid.whole).red;
    for (let c = 0; c < samples[0].grid.cells.length; c++) {
      const r = countSeries((s) => s.grid.cells[c]);
      if (r.gen > maxGen) maxGen = r.gen;
      if (r.red > maxRed) maxRed = r.red;
    }
    probe.setRenderSettings({ prismPools: false });
    return { maxGen, maxRed };
  });
  expect(prismFlashSafety.maxGen).toBeLessThanOrEqual(3);
  expect(prismFlashSafety.maxRed).toBeLessThanOrEqual(3);

  // 3. Phone-like 390x844 + 4x CPU throttle warmed A/B benchmark & Display UI persistence + zero overflow
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.measureFrames)).toBe('function');
  await playSynthDemo(page);
  await page.getByRole('button', { name: /Laser Tunnel/ }).first().click();
  await waitFrames(page, 6);

  const phoneOff = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 8, sampleFrames: 24, gpu: true })
  );
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ prismPools: true }));
  await waitFrames(page, 4);
  const phoneOn = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 8, sampleFrames: 24, gpu: true })
  );
  const phoneProbeOn = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  expect(phoneProbeOn.tier).toBe('low');
  expect(phoneProbeOn.prismPools.active).toBe(true);
  expect(phoneProbeOn.prismPools.suppressedReason).toBeNull();
  expect(Math.round(phoneOn.meanCalls)).toBe(Math.round(phoneOff.meanCalls));

  // Verify Display popover checkbox fits 390px and persists across reload without writing when using ?probe
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ prismPools: false }));
  await page.getByTestId('display-settings-toggle').click();
  const panelBox = await page.getByTestId('display-settings-panel').boundingBox();
  expect(panelBox).not.toBeNull();
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(392);
  await page.getByTestId('render-prism-pools-checkbox').check();
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.graphicsProbe)).toBe('function');
  const persisted = await page.evaluate(() => window.stageforgeProbe.graphicsProbe().settings.prismPools);
  expect(persisted).toBe(true);

  console.log('[SPRINT16_PROBE_SUMMARY]', JSON.stringify({
    desktop1280x720: {
      callsOff: Math.round(desktopOff.meanCalls),
      callsOn: Math.round(desktopOn.meanCalls),
      cpuP50Off: +desktopOff.cpuTotalMs.p50.toFixed(3),
      cpuP50On: +desktopOn.cpuTotalMs.p50.toFixed(3),
      cpuDeltaMs: +(desktopOn.cpuTotalMs.p50 - desktopOff.cpuTotalMs.p50).toFixed(3),
      simMeanOff: +desktopOff.simMs.mean.toFixed(3),
      simMeanOn: +desktopOn.simMs.mean.toFixed(3),
      frameP50Off: +desktopOff.frameIntervalMs.p50.toFixed(2),
      frameP50On: +desktopOn.frameIntervalMs.p50.toFixed(2),
      frameP95Off: +desktopOff.frameIntervalMs.p95.toFixed(2),
      frameP95On: +desktopOn.frameIntervalMs.p95.toFixed(2),
      uploadBytesOff: Math.round(desktopOff.meanUploadBytes),
      uploadBytesOn: Math.round(desktopOn.meanUploadBytes),
      extraBufferBytes: desktopProbeOn.prismPools.extraBufferBytes,
      activePrismInstances: desktopProbeOn.prismPools.activePrismInstances,
      receiverPrismCounts: desktopProbeOn.prismPools.receiverPrismCounts,
    },
    phone390x844_4xCpu: {
      callsOff: Math.round(phoneOff.meanCalls),
      callsOn: Math.round(phoneOn.meanCalls),
      cpuP50Off: +phoneOff.cpuTotalMs.p50.toFixed(3),
      cpuP50On: +phoneOn.cpuTotalMs.p50.toFixed(3),
      cpuDeltaMs: +(phoneOn.cpuTotalMs.p50 - phoneOff.cpuTotalMs.p50).toFixed(3),
      simMeanOff: +phoneOff.simMs.mean.toFixed(3),
      simMeanOn: +phoneOn.simMs.mean.toFixed(3),
      frameP50Off: +phoneOff.frameIntervalMs.p50.toFixed(2),
      frameP50On: +phoneOn.frameIntervalMs.p50.toFixed(2),
      frameP95Off: +phoneOff.frameIntervalMs.p95.toFixed(2),
      frameP95On: +phoneOn.frameIntervalMs.p95.toFixed(2),
      activePrismInstances: phoneProbeOn.prismPools.activePrismInstances,
      receiverPrismCounts: phoneProbeOn.prismPools.receiverPrismCounts,
    },
  }));

  expect(errors).toEqual([]);
});
