import { expect, test } from '@playwright/test';

const waitFrames = (page, count = 3) =>
  page.evaluate((n) => new Promise((resolve) => {
    let i = 0;
    const step = () => {
      if (++i >= n) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), count);

test('Sprint 15: graphics probe, output controls (bloom/FXAA/MSAA), zero-bloom parity, and lifecycle stability', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' || /THREE\.WebGLProgram/i.test(msg.text())) errors.push(msg.text());
  });

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.graphicsProbe)).toBe('function');
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await waitFrames(page, 6);

  // 1. Verify graphicsProbe fields & fixed visibleMeshes semantics.
  const desktopProbe = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(desktopProbe.backend).toBe('webgl2');
  expect(desktopProbe.tier).toBe('high');
  expect(desktopProbe.contextAntialias).toBe(false);
  expect(desktopProbe.drawingBufferSize.width).toBeGreaterThan(0);
  expect(desktopProbe.cssSize.width).toBe(1280);
  expect(desktopProbe.activePasses).toEqual(['RenderPass', 'UnrealBloomPass', 'OutputPass']);
  expect(desktopProbe.bloomAllocated).toBe(true);
  expect(desktopProbe.bloomActive).toBe(true);
  expect(desktopProbe.stats.visibleMeshes).toBeGreaterThan(0);
  expect(desktopProbe.stats.visibleMeshes).toBeLessThan(desktopProbe.stats.meshes);
  expect(desktopProbe.submittedMeshes).toBeLessThanOrEqual(desktopProbe.stats.visibleMeshes);
  expect(desktopProbe.resources.renderTargetBytesEstimate).toBeGreaterThan(0);

  // Measure warmed baseline (default MSAA + full bloom)
  const baselineMeasure = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 10, sampleFrames: 30, gpu: true })
  );
  expect(baselineMeasure.recordedFrames).toBe(30);
  expect(baselineMeasure.meanCalls).toBeLessThanOrEqual(140);

  // L4 regressions: gpu:false produces zero GPU samples even after gpu:true, and concurrent measureFrames rejects.
  const measureEdgeChecks = await page.evaluate(async () => {
    const p1 = window.stageforgeProbe.measureFrames({ warmupFrames: 2, sampleFrames: 6, gpu: false });
    let concurrentRejected = false;
    try {
      await window.stageforgeProbe.measureFrames({ warmupFrames: 1, sampleFrames: 2, gpu: false });
    } catch {
      concurrentRejected = true;
    }
    const r1 = await p1;
    return { gpuCount: r1.gpuMs.count, gpuStatus: r1.gpuTimerStatus, concurrentRejected };
  });
  expect(measureEdgeChecks.gpuCount).toBe(0);
  expect(measureEdgeChecks.gpuStatus).toBe('unsupported');
  expect(measureEdgeChecks.concurrentRejected).toBe(true);

  // 2. Compare AA modes (MSAA vs FXAA vs none) and bloom modes (full vs half vs off).
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ aa: 'fxaa', bloom: 'full' }));
  await waitFrames(page, 4);
  const fxaaProbe = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(fxaaProbe.composerSamplesRequested).toBe(0);
  expect(fxaaProbe.activePasses).toEqual(['RenderPass', 'UnrealBloomPass', 'OutputPass', 'FXAAPass']);
  // FXAA adds at most 1 draw call compared to MSAA.
  expect(fxaaProbe.stats.calls).toBeLessThanOrEqual(desktopProbe.stats.calls + 1);

  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ aa: 'msaa', bloom: 'half' }));
  await waitFrames(page, 4);
  const halfBloomProbe = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(halfBloomProbe.bloomScale).toBe(0.5);
  expect(halfBloomProbe.resources.renderTargetBytesEstimate).toBeLessThan(desktopProbe.resources.renderTargetBytesEstimate);

  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ aa: 'msaa', bloom: 'off' }));
  await waitFrames(page, 4);
  const noBloomProbe = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(noBloomProbe.bloomAllocated).toBe(false);
  expect(noBloomProbe.bloomActive).toBe(false);
  expect(noBloomProbe.activePasses).toEqual(['RenderPass', 'OutputPass']);
  // Bypassing UnrealBloomPass saves its 13 internal passes.
  expect(desktopProbe.stats.calls - noBloomProbe.stats.calls).toBeGreaterThanOrEqual(10);

  // 3. Zero-bloom parity: bloomStrength = 0 with bloom 'full' (auto-bypassed) vs bloom 'off' (disposed).
  await page.evaluate(() => {
    window.stageforgeProbe.patchShowState({ bloomStrength: 0, autoDirector: false, masterDimmer: 1 });
    window.stageforgeProbe.setRenderSettings({ aa: 'msaa', bloom: 'full' });
  });
  await waitFrames(page, 3);
  const zeroParity = await page.evaluate(async () => {
    const decode = (url) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, c.width, c.height));
      };
      img.onerror = reject;
      img.src = url;
    });
    const probe = window.stageforgeProbe;
    const statsZeroFull = probe.graphicsProbe();
    const imgZeroFull = probe.redrawAndCapture();
    probe.setRenderSettings({ aa: 'msaa', bloom: 'off' });
    const statsZeroOff = probe.graphicsProbe();
    const imgZeroOff = probe.redrawAndCapture();
    const [a, b] = await Promise.all([decode(imgZeroFull), decode(imgZeroOff)]);
    let maxLsb = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      maxLsb = Math.max(
        maxLsb,
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2]),
      );
    }
    return {
      maxLsb,
      bloomActiveFull: statsZeroFull.bloomActive,
      bloomAllocatedFull: statsZeroFull.bloomAllocated,
      bloomAllocatedOff: statsZeroOff.bloomAllocated,
      callsFull: statsZeroFull.stats.calls,
      callsOff: statsZeroOff.stats.calls,
    };
  });
  expect(zeroParity.bloomActiveFull).toBe(false);
  expect(zeroParity.bloomAllocatedFull).toBe(true);
  expect(zeroParity.bloomAllocatedOff).toBe(false);
  expect(zeroParity.callsFull).toBe(zeroParity.callsOff);
  expect(zeroParity.maxLsb).toBeLessThanOrEqual(1);

  // Restore defaults & verify monotonic dimmer ramp + saturated RGB emitter region (static manual aim, >334 ms apart).
  await page.evaluate(() => {
    window.stageforgeProbe.setRenderSettings({ aa: 'auto', bloom: 'auto' });
    window.stageforgeProbe.patchShowState({
      bloomStrength: 0.38,
      primaryColor: '#ff0000',
      accentColor: '#0000ff',
      blackout: false,
      movementMode: 'manual',
      manualPan: 0,
      manualTilt: 0.4,
      beamIntensity: 1,
      washIntensity: 1,
      led: { enabled: true, brightness: 1, visualMode: 'cybergrid', speed: 0 },
    });
  });
  const ramp = await page.evaluate(() => {
    const sample = (masterDimmer) => {
      window.stageforgeProbe.patchShowState({ masterDimmer });
      // Advance 400 ms (> 334 ms flash refractory) in two bounded steps so the preview governor admits each steady level.
      window.stageforgeProbe.stepAndReadLuminance(200);
      return window.stageforgeProbe.stepAndReadLuminance(200).grid.whole;
    };
    return { low: sample(0.25), mid: sample(0.55), high: sample(1.0) };
  });
  expect(ramp.high.y).toBeGreaterThan(ramp.mid.y);
  expect(ramp.mid.y).toBeGreaterThan(ramp.low.y);

  // 4. Lifecycle stability: repeated AA/bloom switches, resizes, and rig rebuilds stabilize with zero leaks.
  const lifecycle = await page.evaluate(async () => {
    const next = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const probe = window.stageforgeProbe;
    // Warm up both paths first
    probe.setRenderSettings({ aa: 'fxaa', bloom: 'off' });
    await next();
    probe.setRenderSettings({ aa: 'msaa', bloom: 'full' });
    await next();
    const before = probe.graphicsProbe();
    for (let i = 0; i < 6; i++) {
      probe.setRenderSettings({ aa: i % 2 === 0 ? 'fxaa' : 'msaa', bloom: i % 2 === 0 ? 'half' : 'full' });
      await next();
      probe.rebuildRig();
      await next();
    }
    probe.setRenderSettings({ aa: 'msaa', bloom: 'full' });
    await next();
    const after = probe.graphicsProbe();
    return { before, after };
  });
  expect(lifecycle.after.stats.geometries).toBeLessThanOrEqual(lifecycle.before.stats.geometries + 2);
  expect(lifecycle.after.stats.textures).toBeLessThanOrEqual(lifecycle.before.stats.textures + 2);
  expect(lifecycle.after.gpuTimerPending).toBe(0);

  // 5. Phone-like 390x844 (4x CPU throttle) measurement & Display popover zero-overflow check.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.graphicsProbe)).toBe('function');
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await waitFrames(page, 6);

  const phoneProbe = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(phoneProbe.tier).toBe('low');
  expect(phoneProbe.particles.smoke.capacity).toBe(120);
  expect(phoneProbe.particles.cryo.capacity).toBe(180);
  expect(phoneProbe.particles.haze.capacity).toBe(18);
  const phoneDefaultMeasure = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 8, sampleFrames: 24, gpu: true })
  );
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ bloom: 'off', aa: 'none' }));
  await waitFrames(page, 4);
  const phoneLightMeasure = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 8, sampleFrames: 24, gpu: true })
  );
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  // Open Display & safety on 390px phone and verify zero horizontal overflow.
  await page.getByTestId('display-settings-toggle').click();
  await expect(page.getByTestId('display-settings-panel')).toBeVisible();
  const box = await page.getByTestId('display-settings-panel').boundingBox();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(392);

  // Log measured probe summary for HANDOFF.md Overnight log.
  console.log('[SPRINT15_PROBE_SUMMARY]', JSON.stringify({
    desktopDefault: {
      calls: desktopProbe.stats.calls,
      triangles: desktopProbe.stats.triangles,
      visibleMeshes: desktopProbe.stats.visibleMeshes,
      submittedMeshes: desktopProbe.submittedMeshes,
      rtMiB: +(desktopProbe.resources.renderTargetBytesEstimate / 1048576).toFixed(2),
      frameP50: +baselineMeasure.frameIntervalMs.p50.toFixed(2),
      frameP95: +baselineMeasure.frameIntervalMs.p95.toFixed(2),
      cpuP50: +baselineMeasure.cpuTotalMs.p50.toFixed(2),
      simMean: +baselineMeasure.simMs.mean.toFixed(2),
      crowdMean: +baselineMeasure.crowdMs.mean.toFixed(2),
      particlesMean: +baselineMeasure.particlesMs.mean.toFixed(2),
      batchSyncMean: +baselineMeasure.batchSyncMs.mean.toFixed(2),
      renderSubmitMean: +baselineMeasure.renderSubmitMs.mean.toFixed(2),
      gpuTimerStatus: baselineMeasure.gpuTimerStatus,
      debugRenderer: desktopProbe.debugRenderer,
    },
    desktopFxaaCalls: fxaaProbe.stats.calls,
    desktopHalfBloomRtMiB: +(halfBloomProbe.resources.renderTargetBytesEstimate / 1048576).toFixed(2),
    desktopBloomOffCalls: noBloomProbe.stats.calls,
    phoneDefault: {
      calls: phoneProbe.stats.calls,
      triangles: phoneProbe.stats.triangles,
      rtMiB: +(phoneProbe.resources.renderTargetBytesEstimate / 1048576).toFixed(2),
      frameP50: +phoneDefaultMeasure.frameIntervalMs.p50.toFixed(2),
      frameP95: +phoneDefaultMeasure.frameIntervalMs.p95.toFixed(2),
      cpuP50: +phoneDefaultMeasure.cpuTotalMs.p50.toFixed(2),
    },
    phoneBloomOffNone: {
      calls: Math.round(phoneLightMeasure.meanCalls),
      frameP50: +phoneLightMeasure.frameIntervalMs.p50.toFixed(2),
      frameP95: +phoneLightMeasure.frameIntervalMs.p95.toFixed(2),
      cpuP50: +phoneLightMeasure.cpuTotalMs.p50.toFixed(2),
    },
  }));

  expect(errors).toEqual([]);
});

test('Sprint 15: post-bloom rendered luminance rolling 1-second flash limiter, positive control, reduced-motion, and physical DMX isolation', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 960, height: 600 });
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.stepAndReadLuminance)).toBe('function');
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await waitFrames(page, 4);

  // Helper: run a jittered-dt sequence in-page and compute rolling 1-second WCAG general & red flash counts.
  const runFlashScenario = (scenarioName) => page.evaluate((mode) => {
    const probe = window.stageforgeProbe;
    const jitterDts = [16, 33, 14, 48, 17, 25, 40, 16];
    const samples = [];
    const physDmxDigest = [];

    // Helper matching src/engine/renderProbe.ts analyzeRollingFlashRate
    const analyze = (seq) => {
      const countSeries = (extract) => {
        const genTimes = [];
        const redTimes = [];
        let anchorY = extract(seq[0]).y;
        let lastGenDir = 0;
        let anchorRed = extract(seq[0]);
        let lastRedDir = 0;
        for (let i = 1; i < seq.length; i++) {
          const t = seq[i].timeMs;
          const m = extract(seq[i]);
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
        const maxWin = (times) => {
          let best = 0;
          let left = 0;
          for (let right = 0; right < times.length; right++) {
            while (times[right] - times[left] >= 1000) left++;
            best = Math.max(best, right - left + 1);
          }
          return Math.ceil(best / 2);
        };
        return { gen: maxWin(genTimes), red: maxWin(redTimes) };
      };
      let maxGen = countSeries((s) => s.grid.whole).gen;
      let maxRed = countSeries((s) => s.grid.whole).red;
      for (let c = 0; c < seq[0].grid.cells.length; c++) {
        const res = countSeries((s) => s.grid.cells[c]);
        if (res.gen > maxGen) maxGen = res.gen;
        if (res.red > maxRed) maxRed = res.red;
      }
      return { maxGen, maxRed };
    };

    // Stabilize initial state
    probe.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: false,
      masterDimmer: 1,
      bloomStrength: 0.45,
      beamIntensity: 1,
      washIntensity: 1,
      blinderLevel: 0,
      strobeRate: 0,
      primaryColor: '#ff0000',
      accentColor: '#ff0000',
      laser: { enabled: true, intensity: 1, strobe: 0, pattern: 'tunnel', beamCount: 12 },
      led: { enabled: true, brightness: 1, visualMode: 'strobe_bars', speed: 1 },
    });
    probe.setProbeBump({});
    probe.stepAndReadLuminance(400);

    let elapsed = 0;
    for (let step = 0; step < 85; step++) {
      const dt = jitterDts[step % jitterDts.length];
      elapsed += dt;
      if (mode === 'strobe_and_lasers') {
        probe.patchShowState({
          strobeRate: 1.0,
          primaryColor: '#ff0000',
          accentColor: '#ffffff',
          laser: { enabled: true, intensity: 1, strobe: 1.0 },
        });
      } else if (mode === 'cue_and_blinder_mash') {
        const flip = Math.floor(elapsed / 120) % 2 === 0;
        probe.patchShowState({
          strobeRate: 0.95,
          primaryColor: flip ? '#ff0000' : '#00ffff',
          accentColor: flip ? '#ff0000' : '#00ffff',
          blinderLevel: flip ? 1 : 0,
          blackout: false,
          laser: { enabled: true, intensity: 1, strobe: 1.0 },
          led: { enabled: true, brightness: 1, visualMode: 'strobe_bars', speed: 1 },
        });
        probe.setProbeBump({ blinder: flip, strobe: !flip });
      } else if (mode === 'blackout_mash') {
        const dark = Math.floor(elapsed / 120) % 2 === 0;
        probe.patchShowState({ blackout: dark, blinderLevel: 1, strobeRate: 0 });
      }
      const res = probe.stepAndReadLuminance(dt);
      samples.push({ timeMs: res.elapsedMs, grid: res.grid });
      physDmxDigest.push(res.physicalDmxU1.slice(0, 64).join(','));
    }

    probe.setProbeBump({});
    probe.patchShowState({ strobeRate: 0, blinderLevel: 0, blackout: false, laser: { strobe: 0 } });
    return { ...analyze(samples), physDmxDigest };
  }, scenarioName);

  // Default limited preview: all scenarios stay <= 3 flashes/s (general AND saturated red).
  const limitedStrobe = await runFlashScenario('strobe_and_lasers');
  expect(limitedStrobe.maxGen).toBeLessThanOrEqual(3);
  expect(limitedStrobe.maxRed).toBeLessThanOrEqual(3);

  const limitedCueMash = await runFlashScenario('cue_and_blinder_mash');
  expect(limitedCueMash.maxGen).toBeLessThanOrEqual(3);
  expect(limitedCueMash.maxRed).toBeLessThanOrEqual(3);

  const limitedBlackout = await runFlashScenario('blackout_mash');
  expect(limitedBlackout.maxGen).toBeLessThanOrEqual(3);

  // Positive control via the real Display & safety UI (L3: Cancel focused first, Tab focus trap, restore on Cancel).
  await page.getByTestId('display-settings-toggle').click();
  await page.getByTestId('full-rate-strobe-checkbox').click();
  await expect(page.getByTestId('full-rate-strobe-confirm')).toBeVisible();
  await expect(page.getByTestId('full-rate-strobe-cancel')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('full-rate-strobe-enable')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('full-rate-strobe-cancel')).toBeFocused();
  await page.getByTestId('full-rate-strobe-cancel').click();
  await expect(page.getByTestId('full-rate-strobe-confirm')).toBeHidden();
  await expect(page.getByTestId('full-rate-strobe-checkbox')).toBeFocused();
  await expect(page.getByTestId('full-rate-strobe-badge')).toBeHidden();

  // Now confirm enable for the session.
  await page.getByTestId('full-rate-strobe-checkbox').click();
  await expect(page.getByTestId('full-rate-strobe-cancel')).toBeFocused();
  await page.getByTestId('full-rate-strobe-enable').click();
  await expect(page.getByTestId('full-rate-strobe-badge')).toBeVisible();
  // Close popover so canvas is unobstructed during readPixels
  await page.keyboard.press('Escape');

  const fullRateCueMash = await runFlashScenario('cue_and_blinder_mash');
  expect(fullRateCueMash.maxGen).toBeGreaterThan(3);

  // Verify prefers-reduced-motion overrides AND clears full-rate opt-in (M1: never silently re-arms on exit).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByTestId('full-rate-strobe-badge')).toBeHidden();
  await page.getByTestId('display-settings-toggle').click();
  await expect(page.getByTestId('full-rate-strobe-checkbox')).toBeDisabled();
  await page.keyboard.press('Escape');

  const reducedMotionCueMash = await runFlashScenario('cue_and_blinder_mash');
  expect(reducedMotionCueMash.maxGen).toBeLessThanOrEqual(3);
  expect(reducedMotionCueMash.maxRed).toBeLessThanOrEqual(3);

  // M1 regression: clearing prefers-reduced-motion must NOT re-arm full-rate strobe without re-confirmation.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await waitFrames(page, 3);
  await expect(page.getByTestId('full-rate-strobe-badge')).toBeHidden();
  const afterReducedMotionOff = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(afterReducedMotionOff.fullRateStrobePreview).toBe(false);

  // M4 regression: `?probe` setRenderSettings is in-memory only and must not write localStorage,
  // whereas toggling the real Display UI checkbox persists across reload.
  await page.evaluate(() => localStorage.removeItem('stageforge.render.v1'));
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ fallingCo2: true }));
  const probeWroteStorage = await page.evaluate(() => localStorage.getItem('stageforge.render.v1'));
  expect(probeWroteStorage).toBeNull();
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ fallingCo2: false }));

  // Toggle fallingCo2 through the real Display popover to verify device persistence across reload.
  await page.getByTestId('display-settings-toggle').click();
  await page.getByTestId('render-falling-co2-checkbox').check();
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.graphicsProbe)).toBe('function');
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await waitFrames(page, 3);
  const afterReload = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(afterReload.fullRateStrobePreview).toBe(false);
  expect(afterReload.settings.fallingCo2).toBe(true);

  // Byte-for-byte physical DMX isolation:
  // 1) Static manual look produces byte-for-byte identical physical DMX with full-rate OFF vs ON.
  // 2) Full-rate strobe preview ON keeps physical DMX dimmer rising edges strictly <= 3/s.
  const dmxParity = await page.evaluate(() => {
    const probe = window.stageforgeProbe;
    probe.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: false,
      masterDimmer: 1,
      strobeRate: 0,
      blinderLevel: 0.7,
      movementMode: 'manual',
      manualPan: 0,
      manualTilt: 0.4,
      primaryColor: '#ff0000',
      laser: { enabled: true, intensity: 1, strobe: 0 },
    });
    // Settle pan/tilt lerp
    for (let i = 0; i < 40; i++) probe.stepAndReadLuminance(25);
    probe.setFullRateStrobePreview(false);
    const staticOff = probe.stepAndReadLuminance(20);
    probe.setFullRateStrobePreview(true);
    const staticOn = probe.stepAndReadLuminance(20);
    const staticExactMatch =
      staticOff.physicalDmxU1.length === 512 &&
      staticOff.physicalDmxU1.every((v, i) => v === staticOn.physicalDmxU1[i]) &&
      staticOff.physicalDmxU2.every((v, i) => v === staticOn.physicalDmxU2[i]);

    // Now run strobeRate 1.0 for 1 second with fullRateStrobePreview = true:
    // physical DMX dimmer channels must still never exceed 3 rising edges/s.
    probe.patchShowState({ strobeRate: 1.0, blinderLevel: 0 });
    const prev = new Array(512).fill(0);
    const edges = new Array(512).fill(0);
    for (let i = 0; i < 50; i++) {
      const r = probe.stepAndReadLuminance(20);
      for (let ch = 0; ch < 512; ch++) {
        if (prev[ch] < 100 && r.physicalDmxU1[ch] >= 200) edges[ch]++;
        prev[ch] = r.physicalDmxU1[ch];
      }
    }
    probe.setFullRateStrobePreview(false);
    return { staticExactMatch, maxPhysicalEdgesPerSec: Math.max(...edges) };
  });
  expect(dmxParity.staticExactMatch).toBe(true);
  expect(dmxParity.maxPhysicalEdgesPerSec).toBeLessThanOrEqual(3);
});

test('Sprint 15: image vs video sRGB colour equivalence diagnosis and videoSrgbDecode opt-in', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 960, height: 600 });
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.stepAndReadLuminance)).toBe('function');
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await waitFrames(page, 4);

  // Extract frame 0 from the repo's real MP4 video (/examples/amber-clouds.mp4) into an identical PNG
  // and compare the rendered main LED wall between the PNG and the paused MP4 with videoSrgbDecode off vs on.
  const comparison = await page.evaluate(async () => {
    const videoUrl = '/examples/amber-clouds.mp4';
    const v = document.createElement('video');
    v.muted = true;
    v.crossOrigin = 'anonymous';
    v.src = videoUrl;
    await new Promise((resolve, reject) => {
      v.onloadeddata = () => resolve();
      v.onerror = () => reject(new Error('Failed to load /examples/amber-clouds.mp4'));
    });
    // Seek to 1.2 s (bright amber cloud frame, past any 0.0 s fade-in) before capturing the reference PNG.
    await new Promise((resolve) => {
      v.onseeked = () => resolve();
      v.currentTime = Math.min(1.2, (v.duration || 2) * 0.4);
    });
    await new Promise((r) => setTimeout(r, 60));

    const c = document.createElement('canvas');
    c.width = v.videoWidth || 256;
    c.height = v.videoHeight || 144;
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const pngBlob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    const pngUrl = URL.createObjectURL(pngBlob);

    const probe = window.stageforgeProbe;
    probe.setRenderSettings({ bloom: 'off', videoSrgbDecode: false });
    probe.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: false,
      masterDimmer: 1,
      primaryColor: '#000000',
      accentColor: '#000000',
      beamIntensity: 0,
      washIntensity: 0,
      blinderLevel: 0,
      strobeRate: 0,
      bloomStrength: 0,
      laser: { enabled: false, intensity: 0 },
      led: { enabled: true, brightness: 1, visualMode: 'custom', customMediaUrl: pngUrl, customMediaType: 'image' },
    });
    await new Promise((r) => setTimeout(r, 250));
    const centerWallY = () => {
      const g = probe.stepAndReadLuminance(20).grid;
      return Math.max(g.cells[27].y, g.cells[28].y, g.cells[35].y, g.cells[36].y);
    };
    const imgOff = centerWallY();

    // Turning videoSrgbDecode on must NEVER alter still images (no double-decode).
    probe.setRenderSettings({ videoSrgbDecode: true });
    const imgOn = centerWallY();

    // Now load the exact same MP4 video on the LED wall and compare videoSrgbDecode off vs on.
    probe.setRenderSettings({ videoSrgbDecode: false });
    probe.patchShowState({
      led: { enabled: true, brightness: 1, visualMode: 'custom', customMediaUrl: videoUrl, customMediaType: 'video' },
    });
    let vidOff = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 80));
      const y = centerWallY();
      if (y > imgOff * 0.5) {
        vidOff = y;
        break;
      }
    }
    probe.setRenderSettings({ videoSrgbDecode: true });
    const vidOn = vidOff !== null ? centerWallY() : null;

    URL.revokeObjectURL(pngUrl);
    probe.setRenderSettings({ bloom: 'auto', videoSrgbDecode: false });
    return { imgOff, imgOn, vidOff, vidOn };
  });

  console.log('[SPRINT15_VIDEO_SRGB]', JSON.stringify(comparison));
  expect(comparison.imgOff).toBeGreaterThan(0.01);
  // Still image must be completely unchanged by videoSrgbDecode (never double-decoded).
  expect(Math.abs(comparison.imgOff - comparison.imgOn)).toBeLessThan(0.002);
  expect(comparison.vidOff).not.toBeNull();
  expect(comparison.vidOn).not.toBeNull();
  // Confirm un-decoded video renders brighter than the identical PNG frame, and videoSrgbDecode closes the gap.
  expect(comparison.vidOff).toBeGreaterThan(comparison.imgOff);
  expect(Math.abs(comparison.vidOn - comparison.imgOff)).toBeLessThan(Math.abs(comparison.vidOff - comparison.imgOff));
});

test('Sprint 24 hardening: WebGL frame readback on multi-frame ramps, group colour swaps, laser bumps, blackout control-loop health & context loss', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 960, height: 600 });
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.stepAndReadLuminance)).toBe('function');
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await waitFrames(page, 4);

  const report = await page.evaluate(() => {
    const probe = window.stageforgeProbe;
    probe.setFullRateStrobePreview(false);

    // 1. Multi-frame 5 Hz sawtooth ramp + wash group primaryColor Red/Cyan flips + laser bump mashing
    const samples = [];
    for (let i = 0; i < 120; i++) {
      const dtMs = 1000 / 60;
      const phase = ((i * dtMs) / 200) % 1;
      const saw = Math.min(1, phase * 1.05);
      const redTurn = Math.floor((i * dtMs) / 50) % 2 === 0;
      const bumpOn = Math.floor((i * dtMs) / 50) % 2 === 0;
      probe.patchShowState({
        autoDirector: false,
        audioReactive: false,
        blackout: false,
        masterDimmer: saw,
        beamIntensity: saw,
        washIntensity: 1,
        blinderLevel: 0,
        strobeRate: 0,
        primaryColor: redTurn ? '#ff0000' : '#00ffff',
        movingGroups: {
          wash: {
            movementMode: 'manual',
            movementSpeed: 0,
            movementSpread: 0.4,
            manualPan: 0,
            manualTilt: 0.35,
            focusMarkId: null,
            colorSplitMode: 'solid',
            primaryColor: redTurn ? '#ff0000' : '#00ffff',
            accentColor: '#ffffff',
          },
        },
        laser: {
          enabled: false,
          intensity: 1,
          strobe: 0,
          colorMode: 'custom',
          colorA: redTurn ? '#ff0000' : '#00ffff',
        },
        led: { enabled: true, brightness: saw, visualMode: 'strobe_bars' },
      });
      probe.setProbeBump({ laser: bumpOn, blinder: bumpOn });
      const res = probe.stepAndReadLuminance(dtMs);
      samples.push({ timeMs: res.elapsedMs, grid: res.grid });
    }
    probe.setProbeBump({});

    // Analyze rolling 1 s general & red flash rates across all 64 cells + whole frame inside browser
    const countReversals = (extract) => {
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
        let best = 0, left = 0;
        for (let r = 0; r < arr.length; r++) {
          while (arr[r] - arr[left] >= 1000) left++;
          if (r - left + 1 > best) best = r - left + 1;
        }
        return Math.ceil(best / 2);
      };
      return { gen: maxWin(genTimes), red: maxWin(redTimes) };
    };

    let maxGen = countReversals((s) => s.grid.whole).gen;
    let maxRed = countReversals((s) => s.grid.whole).red;
    for (let c = 0; c < samples[0].grid.cells.length; c++) {
      const r = countReversals((s) => s.grid.cells[c]);
      if (r.gen > maxGen) maxGen = r.gen;
      if (r.red > maxRed) maxRed = r.red;
    }

    // 2. Verify controlLoopHealth still increments under full desk blackout (`shouldRenderScene === false`).
    probe.patchShowState({ blackout: true });
    const hBefore = probe.controlLoopHealth();
    probe.stepAndReadLuminance(20);
    probe.stepAndReadLuminance(20);
    const hAfter = probe.controlLoopHealth();

    return {
      maxGen,
      maxRed,
      seqAdvancedDuringBlackout: hAfter.seq >= hBefore.seq + 2 && !hAfter.standby && !hAfter.contextLost,
    };
  });

  expect(report.maxGen).toBeLessThanOrEqual(3);
  expect(report.maxRed).toBeLessThanOrEqual(3);
  expect(report.seqAdvancedDuringBlackout).toBe(true);

  // 3. Simulate WebGL context loss & recovery via probe hook -> banner appears and clears cleanly.
  await page.evaluate(() => window.stageforgeProbe.simulateContextLoss(true));
  await expect(page.getByTestId('webgl-context-lost-banner')).toBeVisible();
  expect(await page.evaluate(() => window.stageforgeProbe.controlLoopHealth().contextLost)).toBe(true);
  await page.evaluate(() => window.stageforgeProbe.simulateContextLoss(false));
  await expect(page.getByTestId('webgl-context-lost-banner')).toHaveCount(0);
  expect(await page.evaluate(() => window.stageforgeProbe.controlLoopHealth().contextLost)).toBe(false);
});
