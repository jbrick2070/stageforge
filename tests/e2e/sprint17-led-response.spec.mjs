import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('Sprint 17: default-off parity, front/side/grazing views on curved & flat walls, distance sweep, fractional DPR, paused video, brightness zero, secondary screens, GLB invariance & lifecycle', async ({ page, browser }) => {
  test.setTimeout(180_000);
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
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await waitFrames(page, 4);

  // 1. Curved Arena LED wall + Side IMAG wings: default-off parity, front vs side vs extreme grazing, and brightness=0 exact black.
  const curvedAnalysis = await page.evaluate(async () => {
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
    const srgbByteToLinear = (u8) => {
      const s = u8 / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const cropMeanRgb = (img, x0Frac, y0Frac, x1Frac, y1Frac) => {
      const x0 = Math.floor(img.width * x0Frac);
      const x1 = Math.ceil(img.width * x1Frac);
      const y0 = Math.floor(img.height * y0Frac);
      const y1 = Math.ceil(img.height * y1Frac);
      let sum = 0;
      let maxVal = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * img.width + x) * 4;
          const v = (
            srgbByteToLinear(img.data[idx]) +
            srgbByteToLinear(img.data[idx + 1]) +
            srgbByteToLinear(img.data[idx + 2])
          ) / 3;
          sum += v;
          if (v > maxVal) maxVal = v;
          count++;
        }
      }
      return { mean: count > 0 ? sum / count : 0, max: maxVal };
    };
    const maxAbsLsb = (a, b) => {
      let m = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        m = Math.max(
          m,
          Math.abs(a.data[i] - b.data[i]),
          Math.abs(a.data[i + 1] - b.data[i + 1]),
          Math.abs(a.data[i + 2] - b.data[i + 2]),
        );
      }
      return m;
    };

    // Build a uniform mid-tone canvas image well below NeutralToneMapping shoulder so bloom-off captures measure exact shader emissivity.
    const solid = document.createElement('canvas');
    solid.width = 128;
    solid.height = 128;
    const sctx = solid.getContext('2d');
    sctx.fillStyle = 'rgb(145, 185, 215)';
    sctx.fillRect(0, 0, 128, 128);
    const solidBlob = await new Promise((r) => solid.toBlob(r, 'image/png'));
    const solidUrl = URL.createObjectURL(solidBlob);

    const probe = window.stageforgeProbe;
    const initialProbe = probe.graphicsProbe();
    const [cx, cy, cz] = initialProbe.ledWalls.primaryCenter;

    probe.setRenderSettings({ bloom: 'off', aa: 'msaa', ledAngularResponse: false });
    probe.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: false,
      masterDimmer: 1,
      bloomStrength: 0,
      beamIntensity: 0,
      washIntensity: 0,
      blinderLevel: 0,
      strobeRate: 0,
      primaryColor: '#000000',
      accentColor: '#000000',
      atmo: { hazeLevel: 0, smokeOutput: 0, co2Active: false },
      laser: { enabled: false, intensity: 0 },
      led: { enabled: true, brightness: 1, visualMode: 'custom', customMediaUrl: solidUrl, customMediaType: 'image', speed: 0 },
    });
    // Wait for TextureLoader to bind the blob PNG and settle preview governor (> 380 ms)
    await new Promise((r) => setTimeout(r, 200));
    probe.stepAndReadLuminance(220);
    probe.stepAndReadLuminance(220);

    const samplePose = async (deg, dist, captureImages = false) => {
      const rad = (deg * Math.PI) / 180;
      probe.setCameraPose([cx + dist * Math.sin(rad), cy, cz + dist * Math.cos(rad)], [cx, cy, cz]);
      probe.setRenderSettings({ ledAngularResponse: false });
      const imgOff = probe.redrawAndCapture();
      const statsOff = probe.graphicsProbe();
      probe.setRenderSettings({ ledAngularResponse: true });
      const imgOn = probe.redrawAndCapture();
      const statsOn = probe.graphicsProbe();
      probe.setRenderSettings({ ledAngularResponse: false });
      const imgOffAfter = probe.redrawAndCapture();
      const [dOff, dOn, dOffAfter] = await Promise.all([decode(imgOff), decode(imgOn), decode(imgOffAfter)]);
      // Center 8%x12% window right around the camera target [cx, cy, cz] on the LED wall
      const cOff = cropMeanRgb(dOff, 0.46, 0.44, 0.54, 0.56);
      const cOn = cropMeanRgb(dOn, 0.46, 0.44, 0.54, 0.56);
      return {
        offMean: cOff.mean,
        onMean: cOn.mean,
        ratio: cOff.mean > 1e-5 ? cOn.mean / cOff.mean : 0,
        callsOff: statsOff.stats.calls,
        callsOn: statsOn.stats.calls,
        activeOn: statsOn.ledWalls.angularResponseActive,
        offRestoreMaxLsb: maxAbsLsb(dOff, dOffAfter),
        ...(captureImages ? { imgOff, imgOn } : {}),
      };
    };

    const front0 = await samplePose(0, 11, true);
    const side55 = await samplePose(55, 11);
    const grazing78 = await samplePose(78, 10, true);

    // Brightness = 0 check: capture Off and On synchronously in the same JS turn (zero rAF drift)
    probe.setCameraPose([cx, cy, cz + 10], [cx, cy, cz]);
    probe.patchShowState({ led: { enabled: true, brightness: 0, visualMode: 'custom', customMediaUrl: solidUrl, customMediaType: 'image' } });
    probe.stepAndReadLuminance(50);
    probe.setRenderSettings({ ledAngularResponse: false });
    const zeroUrlOff = probe.redrawAndCapture();
    probe.setRenderSettings({ ledAngularResponse: true });
    const zeroUrlOn = probe.redrawAndCapture();
    const [zeroOff, zeroOn] = await Promise.all([decode(zeroUrlOff), decode(zeroUrlOn)]);
    const zeroCropOff = cropMeanRgb(zeroOff, 0.45, 0.42, 0.55, 0.58);
    const zeroCropOn = cropMeanRgb(zeroOn, 0.45, 0.42, 0.55, 0.58);

    // Paused video check (/examples/amber-clouds.mp4 @ 1.2 s) at front vs 78 deg grazing
    const videoUrl = '/examples/amber-clouds.mp4';
    probe.patchShowState({
      led: { enabled: true, brightness: 1, visualMode: 'custom', customMediaUrl: videoUrl, customMediaType: 'video' },
    });
    probe.stepAndReadLuminance(220);
    probe.stepAndReadLuminance(220);
    probe.setPrimaryScreenTransport(false, 1.2);
    let videoReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 80));
      probe.setPrimaryScreenTransport(false, 1.2);
      const g = probe.stepAndReadLuminance(20).grid;
      if (Math.max(g.cells[27].y, g.cells[28].y, g.cells[35].y, g.cells[36].y) > 0.02) {
        videoReady = true;
        break;
      }
    }
    const videoFront = await samplePose(0, 11);
    const videoGrazing = await samplePose(78, 10, true);

    URL.revokeObjectURL(solidUrl);
    probe.setRenderSettings({ bloom: 'auto', ledAngularResponse: false });
    return {
      initialLedWalls: initialProbe.ledWalls,
      front0,
      side55,
      grazing78,
      zeroCropOff,
      zeroCropOn,
      videoReady,
      videoFront,
      videoGrazing,
    };
  });

  if (process.env.SPRINT17_CAPTURE_DIR) {
    await mkdir(process.env.SPRINT17_CAPTURE_DIR, { recursive: true });
    const savePng = (name, url) =>
      writeFile(join(process.env.SPRINT17_CAPTURE_DIR, name), Buffer.from(url.split(',')[1], 'base64'));
    await Promise.all([
      savePng('curved-front-on.png', curvedAnalysis.front0.imgOn),
      savePng('curved-grazing78-off.png', curvedAnalysis.grazing78.imgOff),
      savePng('curved-grazing78-on.png', curvedAnalysis.grazing78.imgOn),
      savePng('video-grazing78-off.png', curvedAnalysis.videoGrazing.imgOff),
      savePng('video-grazing78-on.png', curvedAnalysis.videoGrazing.imgOn),
    ]);
  }

  // Default-off check
  expect(curvedAnalysis.initialLedWalls.angularResponseRequested).toBe(false);
  expect(curvedAnalysis.initialLedWalls.angularResponseActive).toBe(false);
  expect(curvedAnalysis.initialLedWalls.materialCount).toBeGreaterThanOrEqual(2); // curved main wall + Side IMAG wings

  // Zero added draws and bit-identical restoration when toggled off again
  expect(curvedAnalysis.front0.callsOn).toBe(curvedAnalysis.front0.callsOff);
  expect(curvedAnalysis.grazing78.callsOn).toBe(curvedAnalysis.grazing78.callsOff);
  expect(curvedAnalysis.front0.activeOn).toBe(true);
  expect(curvedAnalysis.grazing78.offRestoreMaxLsb).toBeLessThanOrEqual(1);

  // Concave BackSide curved wall: full frontal readability, monotonic side -> grazing attenuation, bounded above floor
  expect(curvedAnalysis.front0.offMean).toBeGreaterThan(0.08);
  expect(curvedAnalysis.front0.ratio).toBeGreaterThan(0.985);
  expect(curvedAnalysis.front0.ratio).toBeLessThanOrEqual(1.005);
  expect(curvedAnalysis.side55.ratio).toBeGreaterThan(0.72);
  expect(curvedAnalysis.side55.ratio).toBeLessThan(0.90);
  expect(curvedAnalysis.grazing78.ratio).toBeGreaterThan(0.30);
  expect(curvedAnalysis.grazing78.ratio).toBeLessThan(0.56);
  expect(curvedAnalysis.front0.ratio).toBeGreaterThan(curvedAnalysis.side55.ratio);
  expect(curvedAnalysis.side55.ratio).toBeGreaterThan(curvedAnalysis.grazing78.ratio);

  // Brightness = 0 stays exact black (<= 0.005 ambient fog/clear) and identical off vs on
  expect(curvedAnalysis.zeroCropOff.max).toBeLessThan(0.005);
  expect(Math.abs(curvedAnalysis.zeroCropOn.mean - curvedAnalysis.zeroCropOff.mean)).toBeLessThan(1e-5);

  // Paused video preserves front brightness and attenuates cleanly at grazing angle
  expect(curvedAnalysis.videoReady).toBe(true);
  expect(curvedAnalysis.videoFront.offMean).toBeGreaterThan(0.02);
  expect(curvedAnalysis.videoFront.ratio).toBeGreaterThan(0.98);
  expect(curvedAnalysis.videoGrazing.ratio).toBeGreaterThan(0.30);
  expect(curvedAnalysis.videoGrazing.ratio).toBeLessThan(0.60);

  // 2. Flat LED wall (Festival Mainstage, curved: false): camera-distance sweep (5 m, 14 m, 32 m) & grazing side view.
  await page.getByRole('button', { name: 'Rig builder', exact: true }).click();
  await page.getByRole('button', { name: /Festival Mainstage/i }).click();
  await page.getByRole('button', { name: 'Close Rig Builder', exact: true }).click();
  await waitFrames(page, 5);

  const flatSweep = await page.evaluate(async () => {
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
    const srgbByteToLinear = (u8) => {
      const s = u8 / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const centerCropMean = (img) => {
      const x0 = Math.floor(img.width * 0.46);
      const x1 = Math.ceil(img.width * 0.54);
      const y0 = Math.floor(img.height * 0.44);
      const y1 = Math.ceil(img.height * 0.56);
      let s = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * img.width + x) * 4;
          s += (
            srgbByteToLinear(img.data[idx]) +
            srgbByteToLinear(img.data[idx + 1]) +
            srgbByteToLinear(img.data[idx + 2])
          ) / 3;
          n++;
        }
      }
      return s / Math.max(1, n);
    };

    const solid = document.createElement('canvas');
    solid.width = 128;
    solid.height = 128;
    const sctx = solid.getContext('2d');
    sctx.fillStyle = 'rgb(150, 180, 210)';
    sctx.fillRect(0, 0, 128, 128);
    const solidBlob = await new Promise((r) => solid.toBlob(r, 'image/png'));
    const solidUrl = URL.createObjectURL(solidBlob);

    const probe = window.stageforgeProbe;
    const [cx, cy, cz] = probe.graphicsProbe().ledWalls.primaryCenter;
    probe.setRenderSettings({ bloom: 'off', ledAngularResponse: false });
    probe.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: false,
      masterDimmer: 1,
      bloomStrength: 0,
      beamIntensity: 0,
      washIntensity: 0,
      blinderLevel: 0,
      strobeRate: 0,
      atmo: { hazeLevel: 0, smokeOutput: 0, co2Active: false },
      laser: { enabled: false, intensity: 0 },
      led: { enabled: true, brightness: 1, visualMode: 'custom', customMediaUrl: solidUrl, customMediaType: 'image', speed: 0 },
    });
    await new Promise((r) => setTimeout(r, 200));
    probe.stepAndReadLuminance(220);
    probe.stepAndReadLuminance(220);

    const distanceUrls = {};
    for (const d of [5, 14, 32]) {
      probe.setCameraPose([cx, cy, cz + d], [cx, cy, cz]);
      probe.setRenderSettings({ ledAngularResponse: false });
      const uOff = probe.redrawAndCapture();
      probe.setRenderSettings({ ledAngularResponse: true });
      const uOn = probe.redrawAndCapture();
      distanceUrls[d] = [uOff, uOn];
    }

    const rad80 = (80 * Math.PI) / 180;
    probe.setCameraPose([cx + 12 * Math.sin(rad80), cy, cz + 12 * Math.cos(rad80)], [cx, cy, cz]);
    probe.setRenderSettings({ ledAngularResponse: false });
    const gUrlOff = probe.redrawAndCapture();
    probe.setRenderSettings({ ledAngularResponse: true });
    const gUrlOn = probe.redrawAndCapture();

    const distances = {};
    for (const d of [5, 14, 32]) {
      const [imgOff, imgOn] = await Promise.all([decode(distanceUrls[d][0]), decode(distanceUrls[d][1])]);
      const mOff = centerCropMean(imgOff);
      const mOn = centerCropMean(imgOn);
      distances[d] = mOff > 1e-5 ? mOn / mOff : 0;
    }
    const [gImgOff, gImgOn] = await Promise.all([decode(gUrlOff), decode(gUrlOn)]);
    const gOff = centerCropMean(gImgOff);
    const gOn = centerCropMean(gImgOn);

    URL.revokeObjectURL(solidUrl);
    probe.setRenderSettings({ bloom: 'auto', ledAngularResponse: false });
    return {
      rigCurved: probe.rig().ledWall.curved,
      distances,
      grazing80Ratio: gOff > 1e-5 ? gOn / gOff : 0,
    };
  });

  expect(flatSweep.rigCurved).toBe(false);
  expect(flatSweep.distances[5]).toBeGreaterThan(0.985);
  expect(flatSweep.distances[14]).toBeGreaterThan(0.985);
  expect(flatSweep.distances[32]).toBeGreaterThan(0.985);
  expect(flatSweep.grazing80Ratio).toBeGreaterThan(0.32);
  expect(flatSweep.grazing80Ratio).toBeLessThan(0.58);

  // 3. GLB export invariance & repeated toggle/rebuild lifecycle check.
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ ledAngularResponse: false }));
  const glbOff = await exportGlbJson(page);
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ ledAngularResponse: true }));
  const glbOn = await exportGlbJson(page);
  expect(glbOn.nodes.length).toBe(glbOff.nodes.length);
  expect(glbOn.meshes.length).toBe(glbOff.meshes.length);
  expect(glbOn.materials.length).toBe(glbOff.materials.length);

  const lifecycle = await page.evaluate(async () => {
    const next = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const probe = window.stageforgeProbe;
    // Warm up both shader variants so Three.js caches both programs
    probe.setRenderSettings({ ledAngularResponse: true });
    probe.redrawAndCapture();
    probe.setRenderSettings({ ledAngularResponse: false });
    probe.redrawAndCapture();
    const before = probe.graphicsProbe();
    for (let i = 0; i < 8; i++) {
      probe.setRenderSettings({ ledAngularResponse: i % 2 === 0 });
      await next();
      if (i % 2 === 1) {
        probe.rebuildRig();
        await next();
      }
    }
    probe.setRenderSettings({ ledAngularResponse: false });
    probe.redrawAndCapture();
    const after = probe.graphicsProbe();
    return { before, after };
  });
  expect(lifecycle.after.stats.geometries).toBeLessThanOrEqual(lifecycle.before.stats.geometries + 1);
  expect(lifecycle.after.stats.textures).toBeLessThanOrEqual(lifecycle.before.stats.textures + 1);
  expect(lifecycle.after.stats.programs).toBeLessThanOrEqual(lifecycle.before.stats.programs + 1);

  // 4. Secondary authored screens coverage (`native-authoring-v3.stageforge.show.json`).
  const showFile = fileURLToPath(new URL('../fixtures/native-authoring-v3.stageforge.show.json', import.meta.url));
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const filesDialog = page.getByRole('dialog', { name: 'Show files' });
  await filesDialog.getByLabel('Open show file').setInputFiles(showFile);
  await expect(filesDialog).toBeHidden();
  await waitFrames(page, 4);

  const secondaryCoverage = await page.evaluate(() => {
    const probe = window.stageforgeProbe;
    const off = probe.graphicsProbe().ledWalls;
    probe.setRenderSettings({ ledAngularResponse: true });
    const on = probe.graphicsProbe().ledWalls;
    probe.setRenderSettings({ ledAngularResponse: false });
    return { off, on };
  });
  expect(secondaryCoverage.off.secondaryMaterialCount).toBeGreaterThanOrEqual(1);
  expect(secondaryCoverage.off.angularResponseActive).toBe(false);
  expect(secondaryCoverage.on.secondaryMaterialCount).toBeGreaterThanOrEqual(1);
  expect(secondaryCoverage.on.angularResponseActive).toBe(true);

  expect(errors).toEqual([]);

  // 5. Fractional DPR (`deviceScaleFactor: 1.5`) context check with cabinet seams & pixel snapping active.
  await page.close();
  const dprContext = await browser.newContext({
    viewport: { width: 960, height: 600 },
    deviceScaleFactor: 1.5,
  });
  const dprPage = await dprContext.newPage();
  const dprErrors = [];
  dprPage.on('pageerror', (err) => dprErrors.push(err.message));
  dprPage.on('console', (msg) => {
    if (msg.type() === 'error' || /THREE\.WebGLProgram/i.test(msg.text())) dprErrors.push(msg.text());
  });
  await dprPage.goto('/?probe');
  await expect.poll(() => dprPage.evaluate(() => typeof window.stageforgeProbe?.graphicsProbe)).toBe('function');
  await dprPage.getByRole('button', { name: 'Play demo', exact: true }).click();
  await dprPage.getByRole('button', { name: /Arena Rock/ }).first().click();
  await dprPage.getByRole('button', { name: 'Pause', exact: true }).click();
  await waitFrames(dprPage, 5);

  // Enable real LED cabinets (activates uPixelSnap + uCabinetGrid seams) under fractional DPR 1.5
  await dprPage.getByRole('button', { name: 'Rig builder', exact: true }).click();
  const cabinetCheckbox = dprPage.getByRole('checkbox', { name: /Use individual LED cabinets/i });
  if (await cabinetCheckbox.count()) {
    await cabinetCheckbox.check();
  }
  await dprPage.getByRole('button', { name: 'Close Rig Builder', exact: true }).click();
  await waitFrames(dprPage, 4);

  const dprResult = await dprPage.evaluate(async () => {
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
    const srgbByteToLinear = (u8) => {
      const s = u8 / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const centerMean = (img) => {
      const x0 = Math.floor(img.width * 0.45);
      const x1 = Math.ceil(img.width * 0.55);
      const y0 = Math.floor(img.height * 0.43);
      const y1 = Math.ceil(img.height * 0.57);
      let s = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * img.width + x) * 4;
          s += (
            srgbByteToLinear(img.data[idx]) +
            srgbByteToLinear(img.data[idx + 1]) +
            srgbByteToLinear(img.data[idx + 2])
          ) / 3;
          n++;
        }
      }
      return s / Math.max(1, n);
    };
    const probe = window.stageforgeProbe;
    const gp = probe.graphicsProbe();
    const [cx, cy, cz] = gp.ledWalls.primaryCenter;
    probe.setRenderSettings({ bloom: 'off', ledAngularResponse: false });
    probe.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: false,
      masterDimmer: 1,
      bloomStrength: 0,
      beamIntensity: 0,
      washIntensity: 0,
      blinderLevel: 0,
      strobeRate: 0,
      atmo: { hazeLevel: 0, smokeOutput: 0, co2Active: false },
      laser: { enabled: false, intensity: 0 },
      led: { enabled: true, brightness: 1, visualMode: 'cybergrid', speed: 0 },
    });
    probe.stepAndReadLuminance(220);
    probe.stepAndReadLuminance(220);

    probe.setCameraPose([cx, cy, cz + 8], [cx, cy, cz]);
    probe.setRenderSettings({ ledAngularResponse: false });
    const fUrlOff = probe.redrawAndCapture();
    probe.setRenderSettings({ ledAngularResponse: true });
    const fUrlOn = probe.redrawAndCapture();

    const rad76 = (76 * Math.PI) / 180;
    probe.setCameraPose([cx + 9 * Math.sin(rad76), cy, cz + 9 * Math.cos(rad76)], [cx, cy, cz]);
    probe.setRenderSettings({ ledAngularResponse: false });
    const gUrlOff = probe.redrawAndCapture();
    const gpOff = probe.graphicsProbe();
    probe.setRenderSettings({ ledAngularResponse: true });
    const gUrlOn = probe.redrawAndCapture();
    const gpOn = probe.graphicsProbe();

    const [fImgOff, fImgOn, gImgOff, gImgOn] = await Promise.all([
      decode(fUrlOff),
      decode(fUrlOn),
      decode(gUrlOff),
      decode(gUrlOn),
    ]);
    const fOff = centerMean(fImgOff);
    const fOn = centerMean(fImgOn);
    const gOff = centerMean(gImgOff);
    const gOn = centerMean(gImgOn);

    return {
      dpr: gp.devicePixelRatio,
      rendererDpr: gp.rendererPixelRatio,
      callsEqual: gpOn.stats.calls === gpOff.stats.calls,
      frontRatio: fOff > 1e-5 ? fOn / fOff : 0,
      grazingRatio: gOff > 1e-5 ? gOn / gOff : 0,
    };
  });
  expect(dprResult.dpr).toBeCloseTo(1.5, 2);
  expect(dprResult.rendererDpr).toBeGreaterThan(1.0);
  expect(dprResult.callsEqual).toBe(true);
  expect(dprResult.frontRatio).toBeGreaterThan(0.97);
  expect(dprResult.grazingRatio).toBeGreaterThan(0.30);
  expect(dprResult.grazingRatio).toBeLessThan(0.68);
  expect(dprErrors).toEqual([]);
  await dprContext.close();
});

test('Sprint 17: warmed desktop & 390x844 phone-like probe budgets, side-view flash-limit safety, and Display UI persistence', async ({ page }) => {
  test.setTimeout(150_000);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' || /THREE\.WebGLProgram/i.test(msg.text())) errors.push(msg.text());
  });

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.measureFrames)).toBe('function');
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await waitFrames(page, 8);

  // 1. Desktop 1280x720 warmed A/B benchmark (Arena Rock)
  await page.evaluate(() => {
    const probe = window.stageforgeProbe;
    // Warm up compiled LED_ANGULAR_RESPONSE program first so steady-state frame cost is measured cleanly
    probe.setRenderSettings({ ledAngularResponse: true });
    probe.redrawAndCapture();
    probe.setRenderSettings({ ledAngularResponse: false });
    probe.redrawAndCapture();
  });
  await waitFrames(page, 4);
  const desktopOff = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 10, sampleFrames: 30, gpu: true })
  );
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ ledAngularResponse: true }));
  await waitFrames(page, 4);
  const desktopOn = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 10, sampleFrames: 30, gpu: true })
  );
  const desktopProbeOn = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(Math.round(desktopOn.meanCalls)).toBe(Math.round(desktopOff.meanCalls));
  expect(desktopProbeOn.ledWalls.angularResponseActive).toBe(true);

  // 2. Side-view (72 deg oblique) flash-limiter safety check with ledAngularResponse: true
  const sideFlashSafety = await page.evaluate(() => {
    const probe = window.stageforgeProbe;
    const [cx, cy, cz] = probe.graphicsProbe().ledWalls.primaryCenter;
    const rad72 = (72 * Math.PI) / 180;
    probe.setCameraPose([cx + 10 * Math.sin(rad72), cy, cz + 10 * Math.cos(rad72)], [cx, cy, cz]);
    probe.setFullRateStrobePreview(false);
    probe.setRenderSettings({ ledAngularResponse: true });
    probe.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: false,
      masterDimmer: 1,
      beamIntensity: 0,
      washIntensity: 0,
      blinderLevel: 0,
      strobeRate: 0,
      laser: { enabled: false, intensity: 0 },
      led: { enabled: true, brightness: 1, visualMode: 'strobe_bars', speed: 1 },
      primaryColor: '#ff0000',
      accentColor: '#00f0ff',
    });
    for (let i = 0; i < 25; i++) probe.stepAndReadLuminance(25);

    const samples = [];
    for (let step = 0; step < 60; step++) {
      const flip = Math.floor((step * 25) / 50) % 2 === 0;
      probe.patchShowState({
        primaryColor: flip ? '#ff0000' : '#00f0ff',
        led: { enabled: true, brightness: flip ? 1.0 : 0.05, visualMode: 'strobe_bars', speed: 1 },
      });
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
    probe.setRenderSettings({ ledAngularResponse: false });
    return { maxGen, maxRed };
  });
  expect(sideFlashSafety.maxGen).toBeLessThanOrEqual(3);
  expect(sideFlashSafety.maxRed).toBeLessThanOrEqual(3);

  // 3. Phone-like 390x844 + 4x CPU throttle warmed A/B benchmark & Display UI persistence + zero overflow
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.measureFrames)).toBe('function');
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await waitFrames(page, 4);

  await page.evaluate(() => {
    const probe = window.stageforgeProbe;
    probe.setRenderSettings({ ledAngularResponse: true });
    probe.redrawAndCapture();
    probe.setRenderSettings({ ledAngularResponse: false });
    probe.redrawAndCapture();
  });
  await waitFrames(page, 4);
  const phoneOff = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 8, sampleFrames: 24, gpu: true })
  );
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ ledAngularResponse: true }));
  await waitFrames(page, 4);
  const phoneOn = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 8, sampleFrames: 24, gpu: true })
  );
  const phoneProbeOn = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  expect(phoneProbeOn.tier).toBe('low');
  expect(phoneProbeOn.ledWalls.angularResponseActive).toBe(true);
  expect(Math.round(phoneOn.meanCalls)).toBe(Math.round(phoneOff.meanCalls));

  // Verify Display popover checkbox fits 390px and persists across reload without writing when using ?probe
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ ledAngularResponse: false }));
  await page.getByTestId('display-settings-toggle').click();
  const panelBox = await page.getByTestId('display-settings-panel').boundingBox();
  expect(panelBox).not.toBeNull();
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(392);
  await page.getByTestId('render-led-angular-checkbox').check();
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.graphicsProbe)).toBe('function');
  const persisted = await page.evaluate(() => window.stageforgeProbe.graphicsProbe().settings.ledAngularResponse);
  expect(persisted).toBe(true);

  console.log('[SPRINT17_PROBE_SUMMARY]', JSON.stringify({
    desktop1280x720: {
      callsOff: Math.round(desktopOff.meanCalls),
      callsOn: Math.round(desktopOn.meanCalls),
      cpuP50Off: +desktopOff.cpuTotalMs.p50.toFixed(3),
      cpuP50On: +desktopOn.cpuTotalMs.p50.toFixed(3),
      cpuDeltaMs: +(desktopOn.cpuTotalMs.p50 - desktopOff.cpuTotalMs.p50).toFixed(3),
      renderSubmitMeanOff: +desktopOff.renderSubmitMs.mean.toFixed(3),
      renderSubmitMeanOn: +desktopOn.renderSubmitMs.mean.toFixed(3),
      frameP50Off: +desktopOff.frameIntervalMs.p50.toFixed(2),
      frameP50On: +desktopOn.frameIntervalMs.p50.toFixed(2),
      frameP95Off: +desktopOff.frameIntervalMs.p95.toFixed(2),
      frameP95On: +desktopOn.frameIntervalMs.p95.toFixed(2),
      gpuP50Off: desktopOff.gpuMs.count > 0 ? +desktopOff.gpuMs.p50.toFixed(3) : null,
      gpuP50On: desktopOn.gpuMs.count > 0 ? +desktopOn.gpuMs.p50.toFixed(3) : null,
      ledWalls: desktopProbeOn.ledWalls,
    },
    phone390x844_4xCpu: {
      callsOff: Math.round(phoneOff.meanCalls),
      callsOn: Math.round(phoneOn.meanCalls),
      cpuP50Off: +phoneOff.cpuTotalMs.p50.toFixed(3),
      cpuP50On: +phoneOn.cpuTotalMs.p50.toFixed(3),
      cpuDeltaMs: +(phoneOn.cpuTotalMs.p50 - phoneOff.cpuTotalMs.p50).toFixed(3),
      renderSubmitMeanOff: +phoneOff.renderSubmitMs.mean.toFixed(3),
      renderSubmitMeanOn: +phoneOn.renderSubmitMs.mean.toFixed(3),
      frameP50Off: +phoneOff.frameIntervalMs.p50.toFixed(2),
      frameP50On: +phoneOn.frameIntervalMs.p50.toFixed(2),
      frameP95Off: +phoneOff.frameIntervalMs.p95.toFixed(2),
      frameP95On: +phoneOn.frameIntervalMs.p95.toFixed(2),
      gpuP50Off: phoneOff.gpuMs.count > 0 ? +phoneOff.gpuMs.p50.toFixed(3) : null,
      gpuP50On: phoneOn.gpuMs.count > 0 ? +phoneOff.gpuMs.p50.toFixed(3) : null,
      ledWalls: phoneProbeOn.ledWalls,
    },
  }));

  expect(errors).toEqual([]);
});
