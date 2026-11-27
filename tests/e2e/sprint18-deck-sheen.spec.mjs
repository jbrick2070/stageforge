import { playSynthDemo } from '../support/play-synth-demo.mjs';
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
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

async function exportGlbParts(page) {
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const files = page.getByRole('dialog', { name: 'Show files' });
  const download = page.waitForEvent('download');
  await files.getByRole('button', { name: '3D scene GLB' }).click();
  const glb = await readFile(await (await download).path());
  await files.getByRole('button', { name: 'Close Show files' }).click();
  await expect(files).toBeHidden();
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

test('Sprint 18: default-off parity, close grazing & far FOH specular response, anti-shimmer sweep, legacy & platform decks, GLB invariance, and toggle/context-restore lifecycle', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' || /THREE\.WebGLProgram/i.test(msg.text())) errors.push(msg.text());
  });

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.graphicsProbe)).toBe('function');
  await playSynthDemo(page);
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await waitFrames(page, 4);

  // 1. Default-off state, close grazing highlight breakup, and far FOH anti-shimmer sweep on legacy BoxGeometry deck.
  const deckAnalysis = await page.evaluate(async () => {
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
    const cropStats = (imgA, imgB, x0Frac, y0Frac, x1Frac, y1Frac) => {
      const x0 = Math.floor(imgA.width * x0Frac);
      const x1 = Math.ceil(imgA.width * x1Frac);
      const y0 = Math.floor(imgA.height * y0Frac);
      const y1 = Math.ceil(imgA.height * y1Frac);
      let sumA = 0;
      let sumB = 0;
      let sumAbsDiff = 0;
      let maxLsb = 0;
      let count = 0;
      const valsA = [];
      const valsB = [];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * imgA.width + x) * 4;
          const la = (
            srgbByteToLinear(imgA.data[idx]) +
            srgbByteToLinear(imgA.data[idx + 1]) +
            srgbByteToLinear(imgA.data[idx + 2])
          ) / 3;
          const lb = (
            srgbByteToLinear(imgB.data[idx]) +
            srgbByteToLinear(imgB.data[idx + 1]) +
            srgbByteToLinear(imgB.data[idx + 2])
          ) / 3;
          sumA += la;
          sumB += lb;
          sumAbsDiff += Math.abs(la - lb);
          maxLsb = Math.max(
            maxLsb,
            Math.abs(imgA.data[idx] - imgB.data[idx]),
            Math.abs(imgA.data[idx + 1] - imgB.data[idx + 1]),
            Math.abs(imgA.data[idx + 2] - imgB.data[idx + 2]),
          );
          valsA.push(la);
          valsB.push(lb);
          count++;
        }
      }
      const meanA = sumA / Math.max(1, count);
      const meanB = sumB / Math.max(1, count);
      let varA = 0;
      let varB = 0;
      for (let i = 0; i < valsA.length; i++) {
        varA += (valsA[i] - meanA) ** 2;
        varB += (valsB[i] - meanB) ** 2;
      }
      return {
        meanA,
        meanB,
        meanAbsDiff: sumAbsDiff / Math.max(1, count),
        stdA: Math.sqrt(varA / Math.max(1, count)),
        stdB: Math.sqrt(varB / Math.max(1, count)),
        maxLsb,
      };
    };

    const probe = window.stageforgeProbe;
    const initialProbe = probe.graphicsProbe();
    const rig = probe.rig();
    const deckY = rig.stageHeight;

    // Configure clean, deterministic deck-only lighting: beams/lasers/particles off, stage spill + PMREM illuminating the Marley deck.
    probe.setRenderSettings({ bloom: 'off', aa: 'msaa', deckSheen: false });
    probe.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: false,
      masterDimmer: 1,
      bloomStrength: 0,
      beamIntensity: 0,
      washIntensity: 0.9,
      blinderLevel: 0.35,
      strobeRate: 0,
      primaryColor: '#58b8ff',
      accentColor: '#ff78d4',
      atmo: { hazeLevel: 0, smokeOutput: 0, co2Active: false },
      laser: { enabled: false, intensity: 0 },
      led: { enabled: true, brightness: 0.75, visualMode: 'gradient', speed: 0 },
    });
    probe.stepAndReadLuminance(220);
    probe.stepAndReadLuminance(220);

    // Close grazing camera looking across downstage Marley seams & scuffs toward spill lights
    probe.setCameraPose([1.6, deckY + 0.72, rig.stageDepth * 0.44], [-1.2, deckY, -1.8]);
    probe.setRenderSettings({ deckSheen: false });
    const closeOffUrl = probe.redrawAndCapture();
    const gpOff = probe.graphicsProbe();

    probe.setRenderSettings({ deckSheen: true });
    const closeOnUrl = probe.redrawAndCapture();
    const gpOn = probe.graphicsProbe();

    probe.setRenderSettings({ deckSheen: false });
    const closeRestoreUrl = probe.redrawAndCapture();
    const gpAfter = probe.graphicsProbe();

    const [closeOffImg, closeOnImg, closeRestoreImg] = await Promise.all([
      decode(closeOffUrl),
      decode(closeOnUrl),
      decode(closeRestoreUrl),
    ]);
    const closeDiff = cropStats(closeOffImg, closeOnImg, 0.25, 0.52, 0.75, 0.92);
    const closeRestore = cropStats(closeOffImg, closeRestoreImg, 0, 0, 1, 1);

    // Far FOH view + 5-step sub-pixel micro-pan sweep to verify zero temporal shimmer at distance
    const runFohSweep = async (enabled) => {
      probe.setRenderSettings({ deckSheen: enabled });
      const urls = [];
      for (let s = 0; s < 5; s++) {
        const xShift = s * 0.03;
        probe.setCameraPose([xShift, deckY + 3.4, 21.0], [0, deckY, 0.8]);
        urls.push(probe.redrawAndCapture());
      }
      const imgs = await Promise.all(urls.map(decode));
      let maxStepDiff = 0;
      for (let s = 1; s < imgs.length; s++) {
        const st = cropStats(imgs[s - 1], imgs[s], 0.32, 0.54, 0.68, 0.68);
        if (st.meanAbsDiff > maxStepDiff) maxStepDiff = st.meanAbsDiff;
      }
      return { maxStepDiff, firstUrl: urls[0], firstImg: imgs[0] };
    };

    const fohOff = await runFohSweep(false);
    const fohOn = await runFohSweep(true);
    const fohDiff = cropStats(fohOff.firstImg, fohOn.firstImg, 0.32, 0.54, 0.68, 0.68);

    probe.setRenderSettings({ bloom: 'auto', deckSheen: false });
    return {
      initialDeckSheen: initialProbe.deckSheen,
      gpOff: {
        calls: gpOff.stats.calls,
        triangles: gpOff.stats.triangles,
        geometries: gpOff.stats.geometries,
        textures: gpOff.stats.textures,
        deckSheen: gpOff.deckSheen,
      },
      gpOn: {
        calls: gpOn.stats.calls,
        triangles: gpOn.stats.triangles,
        geometries: gpOn.stats.geometries,
        textures: gpOn.stats.textures,
        deckSheen: gpOn.deckSheen,
        extraBytes: gpOn.resources.deckSheenExtraTextureBytes,
      },
      gpAfter: {
        textures: gpAfter.stats.textures,
        deckSheen: gpAfter.deckSheen,
      },
      closeDiff,
      closeRestoreMaxLsb: closeRestore.maxLsb,
      fohMaxStepOff: fohOff.maxStepDiff,
      fohMaxStepOn: fohOn.maxStepDiff,
      fohDiff,
      captures: {
        closeOffUrl,
        closeOnUrl,
        fohOffUrl: fohOff.firstUrl,
        fohOnUrl: fohOn.firstUrl,
      },
    };
  });

  if (process.env.SPRINT18_CAPTURE_DIR) {
    await mkdir(process.env.SPRINT18_CAPTURE_DIR, { recursive: true });
    const savePng = (name, url) =>
      writeFile(join(process.env.SPRINT18_CAPTURE_DIR, name), Buffer.from(url.split(',')[1], 'base64'));
    await Promise.all([
      savePng('deck-close-grazing-off.png', deckAnalysis.captures.closeOffUrl),
      savePng('deck-close-grazing-on.png', deckAnalysis.captures.closeOnUrl),
      savePng('deck-foh-off.png', deckAnalysis.captures.fohOffUrl),
      savePng('deck-foh-on.png', deckAnalysis.captures.fohOnUrl),
    ]);
  }

  // Default-off & deterministic non-wall-clock resource invariants
  expect(deckAnalysis.initialDeckSheen.requested).toBe(false);
  expect(deckAnalysis.initialDeckSheen.active).toBe(false);
  expect(deckAnalysis.initialDeckSheen.extraTextureCount).toBe(0);
  expect(deckAnalysis.initialDeckSheen.extraTextureBytes).toBe(0);

  // High-tier structural & VRAM invariants
  expect(deckAnalysis.gpOn.calls).toBe(deckAnalysis.gpOff.calls);
  expect(deckAnalysis.gpOn.triangles).toBe(deckAnalysis.gpOff.triangles);
  expect(deckAnalysis.gpOn.geometries).toBe(deckAnalysis.gpOff.geometries);
  expect(deckAnalysis.gpOn.deckSheen).toEqual({
    requested: true,
    active: true,
    tier: 'high',
    mapSize: 256,
    roughnessAllocated: true,
    normalAllocated: true,
    extraTextureCount: 2,
    extraTextureBytes: 699_048,
  });
  expect(deckAnalysis.gpOn.extraBytes).toBe(699_048);
  expect(deckAnalysis.gpOn.extraBytes).toBeLessThanOrEqual(734_003);
  expect(deckAnalysis.gpOn.textures).toBe(deckAnalysis.gpOff.textures + 2);

  // Immediate disposal on toggle-off and exact pixel restoration
  expect(deckAnalysis.gpAfter.textures).toBe(deckAnalysis.gpOff.textures);
  expect(deckAnalysis.gpAfter.deckSheen.extraTextureCount).toBe(0);
  expect(deckAnalysis.closeRestoreMaxLsb).toBeLessThanOrEqual(1);

  // Close grazing highlight breakup without plastic/wet brightness blowout
  expect(deckAnalysis.closeDiff.meanA).toBeGreaterThan(0.01);
  expect(deckAnalysis.closeDiff.maxLsb).toBeGreaterThanOrEqual(3);
  expect(deckAnalysis.closeDiff.meanAbsDiff).toBeGreaterThan(0.0008);
  const meanRatio = deckAnalysis.closeDiff.meanB / deckAnalysis.closeDiff.meanA;
  expect(meanRatio).toBeGreaterThan(0.80);
  expect(meanRatio).toBeLessThan(1.20);

  // Far FOH anti-shimmer check
  expect(deckAnalysis.fohMaxStepOn).toBeLessThan(0.005);
  expect(deckAnalysis.fohMaxStepOn).toBeLessThanOrEqual(Math.max(0.0025, deckAnalysis.fohMaxStepOff * 1.5));

  // 2. Same-tier GLB export invariance (`deckSheen: false` vs `deckSheen: true`).
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ deckSheen: false }));
  const glbOff = await exportGlbParts(page);
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ deckSheen: true }));
  const glbOn = await exportGlbParts(page);
  expect(glbOn.json.nodes.length).toBe(glbOff.json.nodes.length);
  expect(glbOn.json.meshes.length).toBe(glbOff.json.meshes.length);
  expect(glbOn.json.materials.length).toBe(glbOff.json.materials.length);
  expect(glbOn.json.textures).toEqual(glbOff.json.textures);
  // GLTFExporter appends embedded image bufferViews as async encodes finish, so
  // compare the referenced bytes rather than their nondeterministic bufferView IDs.
  expect(glbOn.imagePayloads).toEqual(glbOff.imagePayloads);
  const exportedDeckOff = glbOff.json.materials.find((m) => m.name === 'stageDeck');
  const exportedDeckOn = glbOn.json.materials.find((m) => m.name === 'stageDeck');
  expect(exportedDeckOn).toBeDefined();
  expect(exportedDeckOn).toEqual(exportedDeckOff);
  expect(exportedDeckOn.pbrMetallicRoughness.roughnessFactor).toBeCloseTo(0.55, 5);
  expect(exportedDeckOn.pbrMetallicRoughness.metallicRoughnessTexture).toBeUndefined();
  expect(exportedDeckOn.normalTexture).toBeUndefined();

  // 3. Authored multi-platform `buildPlatformDeck` path (`native-authoring-v3.stageforge.show.json`).
  const showFile = fileURLToPath(new URL('../fixtures/native-authoring-v3.stageforge.show.json', import.meta.url));
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const filesDialog = page.getByRole('dialog', { name: 'Show files' });
  await filesDialog.getByLabel('Open show file').setInputFiles(showFile);
  await expect(filesDialog).toBeHidden();
  await waitFrames(page, 4);

  const platformCheck = await page.evaluate(async () => {
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
    const probe = window.stageforgeProbe;
    const rig = probe.rig();
    const platY = rig.platforms?.[0]?.height ?? rig.stageHeight;
    probe.setRenderSettings({ bloom: 'off', deckSheen: false });
    probe.patchShowState({
      autoDirector: false,
      blackout: false,
      masterDimmer: 1,
      washIntensity: 0.9,
      blinderLevel: 0.35,
      beamIntensity: 0,
      strobeRate: 0,
      laser: { enabled: false, intensity: 0 },
    });
    probe.stepAndReadLuminance(220);
    probe.setCameraPose([1.2, platY + 0.75, 4.5], [-0.8, platY, -1.2]);
    const urlOff = probe.redrawAndCapture();
    const statsOff = probe.graphicsProbe();
    probe.setRenderSettings({ deckSheen: true });
    const urlOn = probe.redrawAndCapture();
    const statsOn = probe.graphicsProbe();
    const [imgOff, imgOn] = await Promise.all([decode(urlOff), decode(urlOn)]);
    let maxLsb = 0;
    for (let i = 0; i < imgOff.data.length; i += 4) {
      maxLsb = Math.max(
        maxLsb,
        Math.abs(imgOff.data[i] - imgOn.data[i]),
        Math.abs(imgOff.data[i + 1] - imgOn.data[i + 1]),
        Math.abs(imgOff.data[i + 2] - imgOn.data[i + 2]),
      );
    }
    return {
      hasPlatforms: Array.isArray(rig.platforms) && rig.platforms.length > 0,
      callsOff: statsOff.stats.calls,
      callsOn: statsOn.stats.calls,
      activeOn: statsOn.deckSheen.active,
      maxLsb,
    };
  });
  expect(platformCheck.hasPlatforms).toBe(true);
  expect(platformCheck.callsOn).toBe(platformCheck.callsOff);
  expect(platformCheck.activeOn).toBe(true);
  expect(platformCheck.maxLsb).toBeGreaterThanOrEqual(2);

  // 4. Repeated toggle/rebuild lifecycle & WebGL context-loss / restore while `deckSheen: true`.
  const lifecycle = await page.evaluate(async () => {
    const next = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const probe = window.stageforgeProbe;
    probe.setRenderSettings({ deckSheen: false });
    probe.redrawAndCapture();
    const base = probe.graphicsProbe();

    for (let i = 0; i < 8; i++) {
      probe.setRenderSettings({ deckSheen: i % 2 === 0 });
      await next();
      if (i % 2 === 1) {
        probe.rebuildRig();
        await next();
      }
    }
    probe.setRenderSettings({ deckSheen: false });
    probe.redrawAndCapture();
    const afterToggles = probe.graphicsProbe();

    // Enable deckSheen and exercise WebGL context loss + restore
    probe.setRenderSettings({ deckSheen: true });
    probe.redrawAndCapture();
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2');
    const loseExt = gl?.getExtension('WEBGL_lose_context');
    let contextRestoredOk = true;
    if (loseExt) {
      loseExt.loseContext();
      await new Promise((r) => setTimeout(r, 60));
      loseExt.restoreContext();
      for (let w = 0; w < 40; w++) {
        await new Promise((r) => setTimeout(r, 40));
        if (!probe.graphicsProbe().contextLost) break;
      }
      await next();
      const postRestore = probe.graphicsProbe();
      const postGrid = probe.stepAndReadLuminance(32).grid;
      contextRestoredOk = !postRestore.contextLost && postRestore.deckSheen.active && postGrid.whole.y > 0.001;
    }

    probe.setRenderSettings({ bloom: 'auto', deckSheen: false });
    return {
      baseTex: base.stats.textures,
      afterTex: afterToggles.stats.textures,
      baseGeo: base.stats.geometries,
      afterGeo: afterToggles.stats.geometries,
      contextRestoredOk,
    };
  });
  expect(lifecycle.afterTex).toBe(lifecycle.baseTex);
  expect(lifecycle.afterGeo).toBeLessThanOrEqual(lifecycle.baseGeo + 1);
  expect(lifecycle.contextRestoredOk).toBe(true);
  expect(errors).toEqual([]);
});

test('Sprint 18: warmed desktop & 390x844 phone-like probe budgets, low-tier 128x128 roughness-only invariant, grazing flash safety, and Display UI persistence', async ({ page }) => {
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
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await waitFrames(page, 8);

  // 1. Desktop 1280x720 warmed A/B benchmark (Arena Rock)
  await page.evaluate(() => {
    const probe = window.stageforgeProbe;
    // Pre-warm MeshStandardMaterial roughness+normal shader variant so steady-state frame cost is measured cleanly
    probe.setRenderSettings({ deckSheen: true });
    probe.redrawAndCapture();
    probe.setRenderSettings({ deckSheen: false });
    probe.redrawAndCapture();
  });
  await waitFrames(page, 4);
  const desktopOff = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 10, sampleFrames: 30, gpu: true })
  );
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ deckSheen: true }));
  await waitFrames(page, 4);
  const desktopOn = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 10, sampleFrames: 30, gpu: true })
  );
  const desktopProbeOn = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(Math.round(desktopOn.meanCalls)).toBe(Math.round(desktopOff.meanCalls));
  expect(desktopProbeOn.deckSheen.active).toBe(true);
  expect(desktopProbeOn.deckSheen.extraTextureCount).toBe(2);
  expect(desktopProbeOn.deckSheen.extraTextureBytes).toBe(699_048);

  // 2. Grazing-deck flash-limiter safety check while strobes, blinders, and opposing colours reflect off `deckSheen: true`
  const deckFlashSafety = await page.evaluate(() => {
    const probe = window.stageforgeProbe;
    const rig = probe.rig();
    probe.setCameraPose([0, rig.stageHeight + 0.85, rig.stageDepth * 0.45], [0, rig.stageHeight, -1.5]);
    probe.setFullRateStrobePreview(false);
    probe.setRenderSettings({ deckSheen: true });
    probe.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: false,
      masterDimmer: 1,
      beamIntensity: 0.9,
      washIntensity: 1.0,
      blinderLevel: 0,
      strobeRate: 1.0,
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
        blinderLevel: flip ? 1.0 : 0.0,
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
    probe.setRenderSettings({ deckSheen: false });
    return { maxGen, maxRed };
  });
  expect(deckFlashSafety.maxGen).toBeLessThanOrEqual(3);
  expect(deckFlashSafety.maxRed).toBeLessThanOrEqual(3);

  // 3. Phone-like 390x844 + 4x CPU throttle warmed A/B benchmark, low-tier 128x128 1-texture check & Display UI persistence
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.measureFrames)).toBe('function');
  await playSynthDemo(page);
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await waitFrames(page, 4);

  const phoneProbeOff = await page.evaluate(() => {
    const probe = window.stageforgeProbe;
    probe.setRenderSettings({ deckSheen: true });
    probe.redrawAndCapture();
    probe.setRenderSettings({ deckSheen: false });
    probe.redrawAndCapture();
    return probe.graphicsProbe();
  });
  await waitFrames(page, 4);
  const phoneOff = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 8, sampleFrames: 24, gpu: true })
  );
  await page.evaluate(() => {
    window.stageforgeProbe.setRenderSettings({ deckSheen: true });
    window.stageforgeProbe.redrawAndCapture();
  });
  await waitFrames(page, 4);
  const phoneOn = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 8, sampleFrames: 24, gpu: true })
  );
  const phoneProbeOn = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  expect(phoneProbeOn.tier).toBe('low');
  expect(phoneProbeOn.deckSheen).toEqual({
    requested: true,
    active: true,
    tier: 'low',
    mapSize: 128,
    roughnessAllocated: true,
    normalAllocated: false,
    extraTextureCount: 1,
    extraTextureBytes: 87_380,
  });
  expect(phoneProbeOn.resources.deckSheenExtraTextureBytes).toBeLessThanOrEqual(104_857);
  expect(phoneProbeOn.stats.textures).toBe(phoneProbeOff.stats.textures + 1);
  expect(Math.round(phoneOn.meanCalls)).toBe(Math.round(phoneOff.meanCalls));

  // Verify Display popover checkbox fits 390px and persists across reload without writing when using ?probe
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ deckSheen: false }));
  await page.getByTestId('display-settings-toggle').click();
  const panelBox = await page.getByTestId('display-settings-panel').boundingBox();
  expect(panelBox).not.toBeNull();
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(392);
  await page.getByTestId('render-deck-sheen-checkbox').check();
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.graphicsProbe)).toBe('function');
  const persisted = await page.evaluate(() => window.stageforgeProbe.graphicsProbe().settings.deckSheen);
  expect(persisted).toBe(true);

  console.log('[SPRINT18_PROBE_SUMMARY]', JSON.stringify({
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
      deckSheen: desktopProbeOn.deckSheen,
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
      gpuP50On: phoneOn.gpuMs.count > 0 ? +phoneOn.gpuMs.p50.toFixed(3) : null,
      deckSheen: phoneProbeOn.deckSheen,
    },
  }));

  expect(errors).toEqual([]);
});
