import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const authoredShow = fileURLToPath(new URL('../fixtures/native-authoring-v3.stageforge.show.json', import.meta.url));
const colourBarsPng = fileURLToPath(new URL('../fixtures/sprint23-colour-bars.png', import.meta.url));
const colourBarsWebm = fileURLToPath(new URL('../fixtures/sprint23-colour-bars.webm', import.meta.url));

async function waitFrames(page, count = 4) {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  }, count);
}

async function openAuthoredShow(page) {
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Show files' });
  await dialog.getByLabel('Open show file').setInputFiles(authoredShow);
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await page.evaluate(() => window.stageforgeProbe.screens())).map((s) => s.id))
    .toEqual(['side-led']);
}

async function exportGlbParts(page) {
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const files = page.getByRole('dialog', { name: 'Show files' });
  const download = page.waitForEvent('download');
  await files.getByRole('button', { name: '3D scene GLB' }).click();
  const glb = await readFile(await (await download).path());
  await files.getByRole('button', { name: 'Close Show files' }).click();
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen));
  const binStart = 20 + jsonLen + 8;
  const imagePayloads = (json.images ?? []).map((image) => {
    const view = json.bufferViews[image.bufferView];
    const start = binStart + (view.byteOffset ?? 0);
    return {
      mimeType: image.mimeType,
      sha256: createHash('sha256').update(glb.subarray(start, start + view.byteLength)).digest('hex'),
    };
  });
  return { byteLength: glb.byteLength, imagePayloads, json };
}

test('Sprint 23A: restrained bloom, accessibility policy, export parity, localized references and warmed budgets', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.graphicsProbe)).toBe('function');
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.evaluate(() => {
    const p = window.stageforgeProbe;
    p.setCameraPose([0, 6.2, 24.5], [0, 5.35, -0.6]);
    p.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: false,
      masterDimmer: 1,
      primaryColor: '#00d9ff',
      accentColor: '#ff2d86',
      beamIntensity: 0.82,
      washIntensity: 0.72,
      blinderLevel: 0,
      strobeRate: 0,
      movementMode: 'manual',
      manualPan: 0,
      manualTilt: 0.42,
      bloomStrength: 0.38,
      // Custom-without-media is the shader's static authored-colour fallback: no wall animation can skew A/B frames.
      led: { enabled: true, brightness: 0.72, visualMode: 'custom', customMediaUrl: null, customMediaType: null, speed: 0 },
      laser: { enabled: false, intensity: 0, strobe: 0 },
    });
    p.stepAndReadLuminance(220);
    p.stepAndReadLuminance(220);
  });
  await waitFrames(page, 8);

  const visual = await page.evaluate(async () => {
    const p = window.stageforgeProbe;
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
    const region = (img, x0, y0, x1, y1) => {
      const sx = Math.floor(img.width * x0), ex = Math.ceil(img.width * x1);
      const sy = Math.floor(img.height * y0), ey = Math.ceil(img.height * y1);
      let luma = 0, chroma = 0, halo = 0, cores = 0, count = 0;
      for (let y = sy; y < ey; y++) for (let x = sx; x < ex; x++) {
        const i = (y * img.width + x) * 4;
        const r = img.data[i] / 255, g = img.data[i + 1] / 255, b = img.data[i + 2] / 255;
        const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
        const yy = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        luma += yy;
        chroma += hi - lo;
        if (yy >= 0.08 && yy <= 0.48 && hi - lo > 0.05) halo++;
        if (hi >= 0.58 && hi - lo >= 0.18) cores++;
        count++;
      }
      return { luma: luma / count, chroma: chroma / count, haloFraction: halo / count, coreFraction: cores / count };
    };
    const sample = async (masterDimmer, lookOutput) => {
      p.setRenderSettings({ lookOutput, trueColour: false, reducedEffects: false, bloom: 'auto', aa: 'auto' });
      p.patchShowState({ masterDimmer });
      p.stepAndReadLuminance(220);
      p.stepAndReadLuminance(220);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const img = await decode(p.redrawAndCapture());
      return {
        black: region(img, 0.00, 0.00, 0.20, 0.30),
        stage: region(img, 0.23, 0.16, 0.77, 0.88),
      };
    };
    return {
      darkOff: await sample(0.35, false),
      darkOn: await sample(0.35, true),
      brightOff: await sample(1.0, false),
      brightOn: await sample(1.0, true),
    };
  });
  console.log('[SPRINT23A_LOCALIZED_LOOK]', JSON.stringify(visual));
  for (const level of ['dark', 'bright']) {
    const off = visual[`${level}Off`], on = visual[`${level}On`];
    expect(on.black.luma).toBeLessThanOrEqual(off.black.luma + 1 / 255);
    expect(on.stage.haloFraction).toBeLessThanOrEqual(off.stage.haloFraction * 1.08 + 0.002);
    expect(on.stage.coreFraction).toBeGreaterThan(0.0005);
    expect(on.stage.chroma).toBeGreaterThanOrEqual(off.stage.chroma * 0.88);
  }

  // Opt-in reference refresh: three compact, fixed-camera before/after panels. The normal gate is read-only.
  if (process.env.STAGEFORGE_UPDATE_LOOK_REFS === '1') {
    const references = await page.evaluate(async () => {
      const p = window.stageforgeProbe;
      const decode = (url) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
      });
      const views = [
        { name: 'foh', pos: [0, 6.2, 24.5], target: [0, 5.35, -0.6] },
        { name: 'deck-close', pos: [7.2, 2.4, 10.5], target: [0, 0.35, 0] },
        { name: 'wide', pos: [-16, 9.5, 31], target: [0, 4.8, 0] },
      ];
      const out = [];
      for (const view of views) {
        p.setCameraPose(view.pos, view.target);
        const captures = [];
        for (const enabled of [false, true]) {
          p.setRenderSettings({ lookOutput: enabled, trueColour: false, reducedEffects: false, bloom: 'auto', aa: 'auto' });
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          captures.push(await decode(p.redrawAndCapture()));
        }
        const canvas = document.createElement('canvas');
        canvas.width = 960;
        canvas.height = 292;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#05070b';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(captures[0], 0, 22, 480, 270);
        ctx.drawImage(captures[1], 480, 22, 480, 270);
        ctx.fillStyle = '#e5e7eb';
        ctx.font = '600 14px sans-serif';
        ctx.fillText('Before — Sprint 21 output', 10, 16);
        ctx.fillText('After — Sprint 23A restrained output', 490, 16);
        out.push({ name: view.name, dataUrl: canvas.toDataURL('image/webp', 0.82) });
      }
      return out;
    });
    const dir = join(process.cwd(), 'docs', 'looks');
    await mkdir(dir, { recursive: true });
    for (const reference of references) {
      await writeFile(
        join(dir, `sprint23-a-${reference.name}-before-after.webp`),
        Buffer.from(reference.dataUrl.split(',')[1], 'base64'),
      );
    }
  }

  const prepareExport = async (lookOutput) => {
    await page.evaluate((enabled) => {
      const p = window.stageforgeProbe;
      p.setRenderSettings({ lookOutput: enabled, trueColour: false, reducedEffects: false });
      // Export parity needs a frozen fixture: live fixture materials ease toward authored colours
      // even while audio is paused, so rebuild the same neutral rig before both captures.
      p.patchShowState({
        primaryColor: '#000000', accentColor: '#000000', beamIntensity: 0, washIntensity: 0,
        blinderLevel: 0, strobeRate: 0,
        led: { enabled: false, brightness: 0, visualMode: 'custom', customMediaUrl: null, customMediaType: null },
      });
      p.rebuildRig();
    }, lookOutput);
    await waitFrames(page, 4);
  };
  await prepareExport(false);
  const glbOff = await exportGlbParts(page);
  await prepareExport(true);
  const glbOn = await exportGlbParts(page);
  expect(glbOn.json.nodes.length).toBe(glbOff.json.nodes.length);
  expect(glbOn.json.meshes.length).toBe(glbOff.json.meshes.length);
  expect(glbOn.json.materials).toEqual(glbOff.json.materials);
  expect(glbOn.json.textures).toEqual(glbOff.json.textures);
  expect(glbOn.imagePayloads).toEqual(glbOff.imagePayloads);

  const measurePairs = async (pairs, warmupFrames, sampleFrames) => {
    const out = [];
    for (let i = 0; i < pairs; i++) {
      for (const enabled of [false, true]) {
        await page.evaluate((lookOutput) => window.stageforgeProbe.setRenderSettings({
          lookOutput,
          trueColour: false,
          reducedEffects: false,
          bloom: 'auto',
          aa: 'auto',
        }), enabled);
        await waitFrames(page, 3);
        const report = await page.evaluate(
          ({ warmupFrames: warm, sampleFrames: samples }) =>
            window.stageforgeProbe.measureFrames({ warmupFrames: warm, sampleFrames: samples, gpu: true }),
          { warmupFrames, sampleFrames },
        );
        out.push({ enabled, report, probe: await page.evaluate(() => window.stageforgeProbe.graphicsProbe()) });
      }
    }
    return out;
  };
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

  const desktopPairs = await measurePairs(3, 12, 36);
  const desktopOff = desktopPairs.filter((x) => !x.enabled).map((x) => x.report.cpuTotalMs.p50);
  const desktopOn = desktopPairs.filter((x) => x.enabled).map((x) => x.report.cpuTotalMs.p50);
  const desktopDelta = median(desktopOn) - median(desktopOff);
  const desktopOffProbe = desktopPairs.find((x) => !x.enabled).probe;
  const desktopOnProbe = desktopPairs.find((x) => x.enabled).probe;
  expect(desktopDelta).toBeLessThanOrEqual(0.10);
  expect(desktopOnProbe.stats.calls).toBe(desktopOffProbe.stats.calls);
  expect(desktopOnProbe.stats.textures).toBe(desktopOffProbe.stats.textures);
  expect(desktopOnProbe.stats.geometries).toBe(desktopOffProbe.stats.geometries);
  expect(desktopOnProbe.resources.lookOutputExtraGpuBytes).toBe(0);
  expect(desktopOnProbe.resources.renderTargetBytesEstimate).toBe(desktopOffProbe.resources.renderTargetBytesEstimate);

  await page.getByTestId('display-settings-toggle').click();
  const trueColour = page.getByRole('checkbox', { name: /True colour/ });
  const reducedEffects = page.getByRole('checkbox', { name: /Reduced effects/ });
  await expect(trueColour).toBeVisible();
  await expect(reducedEffects).toBeVisible();
  await trueColour.focus();
  await trueColour.press('Space');
  await expect(page.getByTestId('look-accessibility-status')).toContainText('True colour active');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('stageforge.render.v1')).trueColour)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.graphicsProbe().bloomAllocated)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.graphicsProbe().bloomStrength)).toBe(0.38);
  await trueColour.press('Space');
  await reducedEffects.focus();
  await reducedEffects.press('Space');
  await expect(page.getByTestId('look-accessibility-status')).toContainText('Reduced effects active by device preference');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('stageforge.render.v1')).reducedEffects)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.graphicsProbe().bloomScale)).toBe(0.5);
  await reducedEffects.press('Space');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByTestId('look-accessibility-status')).toContainText('automatically because reduced motion is enabled');
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.graphicsProbe().lookOutput.reducedReason)).toBe('reduced-motion');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.graphicsProbe)).toBe('function');
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await page.evaluate(() => {
    window.stageforgeProbe.patchShowState({
      autoDirector: false, audioReactive: false, masterDimmer: 1, bloomStrength: 0.38,
      primaryColor: '#00d9ff', accentColor: '#ff2d86', beamIntensity: 0.82, washIntensity: 0.72,
      blinderLevel: 0, strobeRate: 0, movementMode: 'manual', manualPan: 0, manualTilt: 0.42,
    });
  });
  const phonePairs = await measurePairs(3, 10, 30);
  const phoneOff = phonePairs.filter((x) => !x.enabled).map((x) => x.report.cpuTotalMs.p50);
  const phoneOn = phonePairs.filter((x) => x.enabled).map((x) => x.report.cpuTotalMs.p50);
  const phoneDelta = median(phoneOn) - median(phoneOff);
  const phoneOffProbe = phonePairs.find((x) => !x.enabled).probe;
  const phoneOnProbe = phonePairs.find((x) => x.enabled).probe;
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  console.log('[SPRINT23A_BUDGET]', JSON.stringify({
    desktop: {
      offP50: desktopOff, onP50: desktopOn, deltaP50: desktopDelta,
      offP95: desktopPairs.filter((x) => !x.enabled).map((x) => x.report.cpuTotalMs.p95),
      onP95: desktopPairs.filter((x) => x.enabled).map((x) => x.report.cpuTotalMs.p95),
      offP99: desktopPairs.filter((x) => !x.enabled).map((x) => x.report.cpuTotalMs.p99),
      onP99: desktopPairs.filter((x) => x.enabled).map((x) => x.report.cpuTotalMs.p99),
      gpuOffP50: desktopPairs.filter((x) => !x.enabled).map((x) => x.report.gpuMs.p50),
      gpuOnP50: desktopPairs.filter((x) => x.enabled).map((x) => x.report.gpuMs.p50),
      debugRenderer: desktopOffProbe.debugRenderer,
    },
    phone: {
      offP50: phoneOff, onP50: phoneOn, deltaP50: phoneDelta,
      offP95: phonePairs.filter((x) => !x.enabled).map((x) => x.report.cpuTotalMs.p95),
      onP95: phonePairs.filter((x) => x.enabled).map((x) => x.report.cpuTotalMs.p95),
      offP99: phonePairs.filter((x) => !x.enabled).map((x) => x.report.cpuTotalMs.p99),
      onP99: phonePairs.filter((x) => x.enabled).map((x) => x.report.cpuTotalMs.p99),
      gpuOffP50: phonePairs.filter((x) => !x.enabled).map((x) => x.report.gpuMs.p50),
      gpuOnP50: phonePairs.filter((x) => x.enabled).map((x) => x.report.gpuMs.p50),
      debugRenderer: phoneOffProbe.debugRenderer,
    },
  }));
  expect(phoneDelta).toBeLessThanOrEqual(0.20);
  expect(phoneOnProbe.lookOutput.reducedReason).toBe('low-tier');
  expect(phoneOnProbe.bloomScale).toBe(0.5);
  expect(phoneOnProbe.stats.calls).toBe(phoneOffProbe.stats.calls);
  expect(phoneOnProbe.resources.lookOutputExtraGpuBytes).toBe(0);
  expect(phoneOnProbe.resources.renderTargetBytesEstimate).toBeLessThan(phoneOffProbe.resources.renderTargetBytesEstimate);

  await page.getByTestId('display-settings-toggle').click();
  await expect(page.getByTestId('display-settings-panel')).toBeVisible();
  await expect(page.getByTestId('look-accessibility-status')).toContainText('automatically for this low-tier device');
  const panelBox = await page.getByTestId('display-settings-panel').boundingBox();
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(392);
});

test('Sprint 23A: controlled intermediate colour bars decode video once on main and secondary walls while stills stay unchanged', async ({ page }) => {
  test.setTimeout(180_000);
  const [pngBytes, webmBytes] = await Promise.all([readFile(colourBarsPng), readFile(colourBarsWebm)]);
  await page.route('**/__sprint23-colour-bars.png', (route) => route.fulfill({
    status: 200, contentType: 'image/png', body: pngBytes,
  }));
  await page.route('**/__sprint23-colour-bars.webm', (route) => route.fulfill({
    status: 200, contentType: 'video/webm', body: webmBytes,
  }));
  await page.setViewportSize({ width: 960, height: 600 });
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.setSecondaryScreenStates)).toBe('function');
  await openAuthoredShow(page);

  const evidence = await page.evaluate(async () => {
    const p = window.stageforgeProbe;
    const nextFrames = async (n = 3) => {
      for (let i = 0; i < n; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
    };
    const imageUrl = '/__sprint23-colour-bars.png';
    const videoUrl = '/__sprint23-colour-bars.webm';

    const decodeCapture = (url) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const cctx = c.getContext('2d');
        cctx.drawImage(img, 0, 0);
        resolve(cctx.getImageData(0, 0, c.width, c.height));
      };
      img.onerror = reject;
      img.src = url;
    });
    const maxDiff = (a, b, crop) => {
      let max = 0;
      const [x0, y0, x1, y1] = crop;
      for (let y = Math.floor(a.height * y0); y < Math.ceil(a.height * y1); y++) {
        for (let x = Math.floor(a.width * x0); x < Math.ceil(a.width * x1); x++) {
          const i = (y * a.width + x) * 4;
          max = Math.max(max, Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
        }
      }
      return max;
    };
    const meanError = (a, b, crop) => {
      let sum = 0, count = 0;
      const [x0, y0, x1, y1] = crop;
      for (let y = Math.floor(a.height * y0); y < Math.ceil(a.height * y1); y++) {
        for (let x = Math.floor(a.width * x0); x < Math.ceil(a.width * x1); x++) {
          const i = (y * a.width + x) * 4;
          const signal = Math.max(a.data[i], a.data[i + 1], a.data[i + 2], b.data[i], b.data[i + 1], b.data[i + 2]);
          if (signal < 8) continue;
          sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
          count += 3;
        }
      }
      return sum / Math.max(1, count);
    };
    const prepareScene = () => {
      p.patchShowState({
        autoDirector: false, audioReactive: false, blackout: false, masterDimmer: 1,
        primaryColor: '#000000', accentColor: '#000000', beamIntensity: 0, washIntensity: 0,
        blinderLevel: 0, strobeRate: 0, bloomStrength: 0,
        laser: { enabled: false, intensity: 0, strobe: 0 },
      });
    };
    const captureMain = async (kind, url, enabled) => {
      p.setRenderSettings({ lookOutput: enabled, videoSrgbDecode: true, bloom: 'off', trueColour: false, reducedEffects: false });
      p.patchShowState({ led: { enabled: true, brightness: 1, visualMode: 'custom', customMediaUrl: url, customMediaType: kind } });
      if (kind === 'video') p.setPrimaryScreenTransport(true, 0);
      await new Promise((resolve) => setTimeout(resolve, kind === 'video' ? 500 : 180));
      await nextFrames(4);
      return decodeCapture(p.redrawAndCapture());
    };
    const captureSecondary = async (kind, url, enabled) => {
      p.setRenderSettings({ lookOutput: enabled, videoSrgbDecode: true, bloom: 'off', trueColour: false, reducedEffects: false });
      p.setSecondaryScreenStates({
        'side-led': { kind, name: `bars.${kind === 'video' ? 'webm' : 'png'}`, url, playing: kind === 'video', offsetSeconds: 0, brightness: 1 },
      });
      await new Promise((resolve) => setTimeout(resolve, kind === 'video' ? 500 : 180));
      await nextFrames(4);
      return decodeCapture(p.redrawAndCapture());
    };

    prepareScene();
    p.setCameraPose([0, 2.15, 0.2], [0, 2.15, -2.85]);
    const mainImageOff = await captureMain('image', imageUrl, false);
    const mainStillDiagOff = p.graphicsProbe().ledWalls.primaryVideoDecodeActive;
    const mainImageOn = await captureMain('image', imageUrl, true);
    const mainStillDiagOn = p.graphicsProbe().ledWalls.primaryVideoDecodeActive;
    const mainVideoOff = await captureMain('video', videoUrl, false);
    const mainVideoOn = await captureMain('video', videoUrl, true);
    const mainProbe = p.graphicsProbe();

    p.patchShowState({ led: { enabled: false, brightness: 0, visualMode: 'custom', customMediaUrl: null, customMediaType: null } });
    p.setCameraPose([4.25, 1.95, 0.0], [4.25, 1.95, -1.95]);
    const sideImageOff = await captureSecondary('image', imageUrl, false);
    const sideStillDiagOff = p.screens().find((s) => s.id === 'side-led');
    const sideImageOn = await captureSecondary('image', imageUrl, true);
    const sideStillDiagOn = p.screens().find((s) => s.id === 'side-led');
    const sideVideoOff = await captureSecondary('video', videoUrl, false);
    const sideVideoOn = await captureSecondary('video', videoUrl, true);
    const sideVideoDiagOn = p.screens().find((s) => s.id === 'side-led');

    const mainCrop = [0.18, 0.18, 0.82, 0.82];
    const sideCrop = [0.25, 0.16, 0.75, 0.84];
    const report = {
      fixture: 'FFmpeg smptebars 320x160: intermediate greys + 75% colour bars',
      main: {
        stillMaxLsb: maxDiff(mainImageOff, mainImageOn, mainCrop),
        stillMeanLsb: meanError(mainImageOff, mainImageOn, mainCrop),
        stillDecodeOff: mainStillDiagOff,
        stillDecodeOn: mainStillDiagOn,
        videoErrorOff: meanError(mainImageOn, mainVideoOff, mainCrop),
        videoErrorOn: meanError(mainImageOn, mainVideoOn, mainCrop),
        decodeMaterials: mainProbe.ledWalls.videoDecodeActiveMaterialCount,
        primaryDecode: mainProbe.ledWalls.primaryVideoDecodeActive,
      },
      secondary: {
        stillMaxLsb: maxDiff(sideImageOff, sideImageOn, sideCrop),
        stillMeanLsb: meanError(sideImageOff, sideImageOn, sideCrop),
        videoErrorOff: meanError(sideImageOn, sideVideoOff, sideCrop),
        videoErrorOn: meanError(sideImageOn, sideVideoOn, sideCrop),
        stillDecodeOff: sideStillDiagOff.videoSrgbDecode,
        stillDecodeOn: sideStillDiagOn.videoSrgbDecode,
        videoDecodeOn: sideVideoDiagOn.videoSrgbDecode,
        videoWidth: sideVideoDiagOn.width,
      },
    };
    return report;
  });

  console.log('[SPRINT23A_COLOUR_BARS]', JSON.stringify(evidence));
  // Canvas/WebGL readback can differ by a few isolated quantization steps across GPU backends.
  // The bounded mean error plus type-gated diagnostics prove stills never enter the video decode path;
  // an actual second sRGB decode shifts intermediate bars by tens of LSBs.
  expect(evidence.main.stillMaxLsb).toBeLessThanOrEqual(4);
  expect(evidence.main.stillMeanLsb).toBeLessThanOrEqual(2);
  expect(evidence.main.stillDecodeOff).toBe(false);
  expect(evidence.main.stillDecodeOn).toBe(false);
  expect(evidence.main.videoErrorOff).toBeGreaterThan(1);
  expect(evidence.main.videoErrorOn).toBeLessThan(evidence.main.videoErrorOff * 0.72);
  expect(evidence.main.primaryDecode).toBe(true);
  expect(evidence.main.decodeMaterials).toBeGreaterThanOrEqual(1);
  expect(evidence.secondary.stillMaxLsb).toBeLessThanOrEqual(4);
  expect(evidence.secondary.stillMeanLsb).toBeLessThanOrEqual(2);
  expect(evidence.secondary.videoErrorOff).toBeGreaterThan(1);
  expect(evidence.secondary.videoErrorOn).toBeLessThan(evidence.secondary.videoErrorOff * 0.72);
  expect(evidence.secondary.stillDecodeOff).toBe(false);
  expect(evidence.secondary.stillDecodeOn).toBe(false);
  expect(evidence.secondary.videoDecodeOn).toBe(true);
  expect(evidence.secondary.videoWidth).toBeGreaterThan(0);
});
