import { playSynthDemo } from '../support/play-synth-demo.mjs';
import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

async function exportGlbBytesAndJson(page) {
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const files = page.getByRole('dialog', { name: 'Show files' });
  const download = page.waitForEvent('download');
  await files.getByRole('button', { name: '3D scene GLB' }).click();
  const glb = await readFile(await (await download).path());
  await files.getByRole('button', { name: 'Close Show files' }).click();
  await expect(files).toBeHidden();
  return {
    byteLength: glb.byteLength,
    json: JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12))),
  };
}

test('Sprint 20: default-off parity, blackout, crossing coloured beams, overlapping smoke & CO2, near-camera fade, GLB & context-restore lifecycle, and flash safety', async ({ page }) => {
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
    const srgbByteToLinear = (u8) => {
      const s = u8 / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const cropStats = (img, x0Frac, y0Frac, x1Frac, y1Frac) => {
      const x0 = Math.floor(img.width * x0Frac);
      const x1 = Math.ceil(img.width * x1Frac);
      const y0 = Math.floor(img.height * y0Frac);
      const y1 = Math.ceil(img.height * y1Frac);
      let sr = 0, sg = 0, sb = 0, maxLin = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * img.width + x) * 4;
          const r = srgbByteToLinear(img.data[i]);
          const g = srgbByteToLinear(img.data[i + 1]);
          const b = srgbByteToLinear(img.data[i + 2]);
          sr += r; sg += g; sb += b;
          const pk = Math.max(r, g, b);
          if (pk > maxLin) maxLin = pk;
          n++;
        }
      }
      return {
        r: sr / Math.max(1, n),
        g: sg / Math.max(1, n),
        b: sb / Math.max(1, n),
        mean: (sr + sg + sb) / (3 * Math.max(1, n)),
        maxLin,
      };
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

    const probe = window.stageforgeProbe;
    const initialLit = probe.graphicsProbe().litPuffs;

    // 1A. Spatial localization check: aim magenta beams & washes sharply toward stage-left (-X)
    //     so stage-left smoke lights up in magenta while stage-right smoke stays dark ambient slate!
    probe.resetParticles(4242);
    probe.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: false,
      masterDimmer: 1,
      beamIntensity: 1.0,
      washIntensity: 1.0,
      beamZoom: 0.25,
      blinderLevel: 0,
      strobeRate: 0,
      primaryColor: '#ff0066',
      accentColor: '#ff0066',
      colorSplitMode: 'solid',
      movementMode: 'manual',
      manualPan: -0.78,
      manualTilt: 0.22,
      movementSpeed: 0,
      movingGroups: {},
      led: { enabled: false, brightness: 0, visualMode: 'cybergrid', speed: 0 },
      laser: { enabled: false, intensity: 0 },
      atmo: { hazeLevel: 0.20, smokeOutput: 1.0, co2Active: false },
    });
    for (let s = 0; s < 28; s++) probe.stepAndReadLuminance(200);

    probe.setCameraPose([0, 3.6, 17.5], [0, 2.4, 2.5]);
    probe.setRenderSettings({ litPuffs: false });
    const spatialOffImg = await decode(probe.redrawAndCapture({ hideBeams: true }));
    const noPuffsSpatialImg = await decode(probe.redrawAndCapture({ hideBeams: true, hideParticles: true }));
    probe.setRenderSettings({ litPuffs: true });
    const spatialOnImg = await decode(probe.redrawAndCapture({ hideBeams: true }));

    const leftBase = cropStats(noPuffsSpatialImg, 0.36, 0.30, 0.47, 0.56);
    const rightBase = cropStats(noPuffsSpatialImg, 0.53, 0.30, 0.64, 0.56);
    const leftSpatialOff = cropStats(spatialOffImg, 0.36, 0.30, 0.47, 0.56);
    const rightSpatialOff = cropStats(spatialOffImg, 0.53, 0.30, 0.64, 0.56);
    const leftSpatialOn = cropStats(spatialOnImg, 0.36, 0.30, 0.47, 0.56);
    const rightSpatialOn = cropStats(spatialOnImg, 0.53, 0.30, 0.64, 0.56);
    const spatialLeftRedAddedOn = Math.max(0, leftSpatialOn.r - leftBase.r);
    const spatialRightRedAddedOn = Math.max(0, rightSpatialOn.r - rightBase.r);
    const spatialLeftRedAddedOff = Math.max(0, leftSpatialOff.r - leftBase.r);
    const spatialRightRedAddedOff = Math.max(0, rightSpatialOff.r - rightBase.r);

    // 1B. Crossing cyan + magenta beams vs pure cyan-only + frozen-frame toggle ON -> OFF parity
    probe.patchShowState({
      primaryColor: '#00f0ff',
      accentColor: '#00f0ff',
      colorSplitMode: 'solid',
      movementMode: 'fan',
      beamZoom: 0.28,
      movingGroups: {},
    });
    for (let s = 0; s < 8; s++) probe.stepAndReadLuminance(200);
    probe.setRenderSettings({ litPuffs: true });
    const cyanOnlyPuffsImg = await decode(probe.redrawAndCapture({ hideBeams: true }));

    probe.patchShowState({
      primaryColor: '#00f0ff',
      accentColor: '#ff0066',
      colorSplitMode: 'alternate',
    });
    for (let s = 0; s < 8; s++) probe.stepAndReadLuminance(200);

    probe.setRenderSettings({ litPuffs: false });
    const fullOffUrl = probe.redrawAndCapture();
    const statsOff = probe.graphicsProbe();
    const noPuffsUrl = probe.redrawAndCapture({ hideBeams: true, hideParticles: true });

    probe.setRenderSettings({ litPuffs: true });
    const fullOnUrl = probe.redrawAndCapture();
    const statsOn = probe.graphicsProbe();
    const puffsOnlyOnUrl = probe.redrawAndCapture({ hideBeams: true });

    probe.setRenderSettings({ litPuffs: false });
    const fullRestoredUrl = probe.redrawAndCapture();
    const statsRestored = probe.graphicsProbe();

    const [fullOff, fullRestored, puffsOn, noPuffs] = await Promise.all([
      decode(fullOffUrl),
      decode(fullRestoredUrl),
      decode(puffsOnlyOnUrl),
      decode(noPuffsUrl),
    ]);
    const restoreMaxLsb = maxAbsLsb(fullOff, fullRestored);
    const centerBase = cropStats(noPuffs, 0.36, 0.30, 0.64, 0.56);
    const centerCyanOnly = cropStats(cyanOnlyPuffsImg, 0.36, 0.30, 0.64, 0.56);
    const centerOn = cropStats(puffsOn, 0.36, 0.30, 0.64, 0.56);
    const cyanOnlySmoke = {
      r: Math.max(0, centerCyanOnly.r - centerBase.r),
      g: Math.max(0, centerCyanOnly.g - centerBase.g),
      b: Math.max(0, centerCyanOnly.b - centerBase.b),
    };
    const crossingSmokeOn = {
      r: Math.max(0, centerOn.r - centerBase.r),
      g: Math.max(0, centerOn.g - centerBase.g),
      b: Math.max(0, centerOn.b - centerBase.b),
    };

    // 2. Blackout parity with alive puffs still in the air (far enough from near-camera fade):
    probe.setCameraPose([0, 4.2, 22.0], [0, 2.5, 2.0]);
    probe.patchShowState({ blackout: true });
    probe.stepAndReadLuminance(50);
    probe.setRenderSettings({ litPuffs: false });
    probe.redrawAndCapture();
    const blkOffUrl = probe.redrawAndCapture();
    probe.setRenderSettings({ litPuffs: true });
    const blkStatsOn = probe.graphicsProbe().litPuffs;
    const blkOnUrl = probe.redrawAndCapture();
    const [blkOff, blkOn] = await Promise.all([decode(blkOffUrl), decode(blkOnUrl)]);
    const blackoutMaxLsb = maxAbsLsb(blkOff, blkOn);

    // 3. Overlapping smoke + CO2 cryo at maximum emissions (plus fallingCo2):
    probe.patchShowState({
      blackout: false,
      masterDimmer: 1,
      beamIntensity: 1.0,
      washIntensity: 1.0,
      primaryColor: '#00f0ff',
      accentColor: '#ff2288',
      atmo: { hazeLevel: 0.35, smokeOutput: 1.0, co2Active: true },
    });
    probe.setRenderSettings({ litPuffs: true, fallingCo2: true });
    for (let s = 0; s < 16; s++) probe.stepAndReadLuminance(120);
    probe.setCameraPose([0, 3.4, 16.5], [0, 2.2, 2.5]);
    const overlapStats = probe.graphicsProbe();
    const overlapOnUrl = probe.redrawAndCapture();
    const overlapImg = await decode(overlapOnUrl);
    const overlapCrop = cropStats(overlapImg, 0.20, 0.18, 0.80, 0.84);

    // 4. Near-camera overdraw / eye-depth fade check: place camera right inside the downstage plume
    const smokeAlive = overlapStats.particles.smoke.alive;
    probe.setCameraPose([0, 1.8, 5.2], [0, 1.8, 3.8]);
    probe.setRenderSettings({ litPuffs: false });
    const nearOffImg = await decode(probe.redrawAndCapture({ hideBeams: true }));
    probe.setRenderSettings({ litPuffs: true });
    const nearOnImg = await decode(probe.redrawAndCapture({ hideBeams: true }));
    const nearMeanOff = cropStats(nearOffImg, 0.15, 0.15, 0.85, 0.85).mean;
    const nearMeanOn = cropStats(nearOnImg, 0.15, 0.15, 0.85, 0.85).mean;

    probe.setRenderSettings({ fallingCo2: false });
    probe.setCameraPose([0, 3.6, 17.5], [0, 2.4, 2.5]);

    return {
      initialLit,
      statsOff,
      statsOn,
      statsRestored,
      restoreMaxLsb,
      spatialLeftRedAddedOn,
      spatialRightRedAddedOn,
      spatialLeftRedAddedOff,
      spatialRightRedAddedOff,
      leftSpatialOn,
      cyanOnlySmoke,
      crossingSmokeOn,
      blackoutMaxLsb,
      blkStatsOn,
      overlapStats,
      overlapCrop,
      smokeAlive,
      nearMeanOff,
      nearMeanOn,
      captures: {
        fullOffUrl,
        fullOnUrl,
        overlapOnUrl,
      },
    };
  });

  // Save inspection PNGs to OS temp folder (never dirtying the git worktree)
  const capDir = join(tmpdir(), 'stageforge-sprint20-captures');
  await mkdir(capDir, { recursive: true });
  for (const [name, dataUrl] of Object.entries(analysis.captures)) {
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    await writeFile(join(capDir, `${name}.png`), Buffer.from(b64, 'base64'));
  }

  expect(analysis.initialLit.requested).toBe(false);
  expect(analysis.initialLit.allocated).toBe(false);
  expect(analysis.initialLit.extraBufferBytes).toBe(0);

  // 0 added draw calls and 0 added textures
  expect(analysis.statsOn.stats.calls).toBe(analysis.statsOff.stats.calls);
  expect(analysis.statsOn.stats.textures).toBe(analysis.statsOff.stats.textures);
  expect(analysis.statsOn.litPuffs.active).toBe(true);
  expect(analysis.statsOn.litPuffs.selectedCandidateCount).toBeGreaterThan(0);
  expect(analysis.statsOn.litPuffs.selectedCandidateCount).toBeLessThanOrEqual(16);
  expect(analysis.statsOn.litPuffs.litSmokePuffs).toBeGreaterThan(0);
  expect(analysis.statsOn.resources.litPuffsExtraBufferBytes).toBe(27_200);
  expect(analysis.statsRestored.resources.litPuffsExtraBufferBytes).toBe(0);
  expect(analysis.restoreMaxLsb).toBeLessThanOrEqual(1);

  // 1A. Spatial localization: left-aimed magenta beams strongly brighten stage-left smoke relative to stage-right smoke
  const leftRightRatioOn = analysis.spatialLeftRedAddedOn / Math.max(1e-4, analysis.spatialRightRedAddedOn);
  const leftRightRatioOff = analysis.spatialLeftRedAddedOff / Math.max(1e-4, analysis.spatialRightRedAddedOff);
  expect(leftRightRatioOn).toBeGreaterThan(leftRightRatioOff * 1.35);
  expect(analysis.spatialLeftRedAddedOn).toBeGreaterThan(analysis.leftSpatialOn.g * 1.15);

  // 1B. Crossing cyan + magenta beams: smoke carries both cyan (G & B) and magenta (R > 2.5x cyan-only R) simultaneously
  expect(analysis.crossingSmokeOn.r).toBeGreaterThan(0.008);
  expect(analysis.crossingSmokeOn.g).toBeGreaterThan(0.012);
  expect(analysis.crossingSmokeOn.b).toBeGreaterThan(0.015);
  expect(analysis.crossingSmokeOn.r).toBeGreaterThan(analysis.cyanOnlySmoke.r * 2.5);

  // Blackout zeroes local puff illumination immediately
  expect(analysis.blkStatsOn.selectedCandidateCount).toBe(0);
  expect(analysis.blkStatsOn.litSmokePuffs).toBe(0);
  expect(analysis.blackoutMaxLsb).toBeLessThanOrEqual(1);

  // Overlapping smoke + CO2 cryo at max emissions: distinct batch renderOrders (1 vs 2), bounded brightness
  expect(analysis.overlapStats.particles.smoke.alive).toBeGreaterThan(20);
  expect(analysis.overlapStats.particles.cryo.alive).toBeGreaterThan(20);
  expect(analysis.overlapStats.litPuffs.litCryoPuffs).toBeGreaterThan(0);
  expect(
    new Set([
      analysis.overlapStats.litPuffs.smokeRenderOrder,
      analysis.overlapStats.litPuffs.cryoRenderOrder,
    ]),
  ).toEqual(new Set([1, 2]));
  expect(analysis.overlapCrop.mean).toBeLessThan(0.75);

  // Near-camera fade stays bounded without blow-out
  expect(analysis.nearMeanOn).toBeLessThan(0.70);

  // 5. GLB export invariance (off vs on vs mid-export toggle overlap; never exports particle attributes)
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ litPuffs: false }));
  const glbOff = await exportGlbBytesAndJson(page);
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ litPuffs: true }));
  const glbOn = await exportGlbBytesAndJson(page);
  expect(glbOn.json.nodes.length).toBe(glbOff.json.nodes.length);
  expect(glbOn.json.meshes.length).toBe(glbOff.json.meshes.length);
  expect(glbOn.json.accessors.length).toBe(glbOff.json.accessors.length);
  expect(glbOn.json.materials.length).toBe(glbOff.json.materials.length);
  expect(glbOn.json.materials.filter((m) => m.name !== 'MeshBasicMaterial')).toEqual(
    glbOff.json.materials.filter((m) => m.name !== 'MeshBasicMaterial'),
  );
  expect(glbOn.json.textures).toEqual(glbOff.json.textures);
  expect(glbOn.json.images?.length).toBe(glbOff.json.images?.length);
  expect(JSON.stringify(glbOn.json)).not.toMatch(/broadLight|lobeLight|lobeOffset/i);

  // Overlap toggle during export trigger
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const filesDialog = page.getByRole('dialog', { name: 'Show files' });
  const overlapDownload = page.waitForEvent('download');
  await filesDialog.getByRole('button', { name: '3D scene GLB' }).click();
  await page.evaluate(() => {
    window.stageforgeProbe.setRenderSettings({ litPuffs: false });
    window.stageforgeProbe.setRenderSettings({ litPuffs: true });
  });
  const glbOverlapBuf = await readFile(await (await overlapDownload).path());
  const overlapJson = JSON.parse(glbOverlapBuf.toString('utf8', 20, 20 + glbOverlapBuf.readUInt32LE(12)));
  await filesDialog.getByRole('button', { name: 'Close Show files' }).click();
  await expect(filesDialog).toBeHidden();
  expect(overlapJson.nodes.length).toBe(glbOff.json.nodes.length);
  expect(overlapJson.meshes.length).toBe(glbOff.json.meshes.length);
  expect(overlapJson.materials.filter((m) => m.name !== 'MeshBasicMaterial')).toEqual(
    glbOff.json.materials.filter((m) => m.name !== 'MeshBasicMaterial'),
  );
  expect(overlapJson.textures).toEqual(glbOff.json.textures);

  // 6. 8-cycle toggle + rig rebuild + pixel-verified context restore + rolling 1s flash-rate check
  const lifecycleAndFlash = await page.evaluate(async () => {
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
    const meanByte = (img) => {
      let s = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        s += img.data[i] + img.data[i + 1] + img.data[i + 2];
      }
      return s / (3 * (img.data.length / 4));
    };

    const probe = window.stageforgeProbe;
    probe.setRenderSettings({ litPuffs: true });
    probe.patchShowState({
      blackout: false,
      masterDimmer: 1,
      beamIntensity: 1,
      washIntensity: 1,
      strobeRate: 0,
      atmo: { hazeLevel: 0.35, smokeOutput: 1.0, co2Active: true },
    });
    probe.rebuildRig();
    for (let s = 0; s < 6; s++) probe.stepAndReadLuminance(100);
    probe.redrawAndCapture();
    const baseline = probe.graphicsProbe().stats;

    for (let i = 0; i < 8; i++) {
      probe.setRenderSettings({ litPuffs: false });
      probe.setRenderSettings({ litPuffs: true });
      if (i % 4 === 3) probe.rebuildRig();
    }
    for (let s = 0; s < 6; s++) probe.stepAndReadLuminance(100);
    const preLossUrl = probe.redrawAndCapture();
    const afterToggles = probe.graphicsProbe().stats;

    // Real WebGL context loss/restore via WEBGL_lose_context -> pixel-verified recovery of vapor texture & lit attributes
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const loseExt = gl?.getExtension?.('WEBGL_lose_context');
    if (loseExt) {
      const restored = new Promise((resolve) => {
        canvas.addEventListener('webglcontextrestored', () => resolve(true), { once: true });
      });
      loseExt.loseContext();
      await new Promise((r) => setTimeout(r, 40));
      loseExt.restoreContext();
      await restored;
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const postRestorePuffsOnlyUrl = probe.redrawAndCapture({ hideBeams: true });
    const postRestoreFullUrl = probe.redrawAndCapture();
    const postRestoreProbe = probe.graphicsProbe();
    const [preLossImg, postRestoreFullImg, postRestorePuffsImg] = await Promise.all([
      decode(preLossUrl),
      decode(postRestoreFullUrl),
      decode(postRestorePuffsOnlyUrl),
    ]);

    // Rolling 1-second luminance flash safety under 12 Hz strobe + primary/accent flips over dense lit smoke & CO2
    probe.patchShowState({
      strobeRate: 0.95,
      atmo: { hazeLevel: 0.4, smokeOutput: 1.0, co2Active: true },
    });
    for (let w = 0; w < 15; w++) probe.stepAndReadLuminance(25);
    const frames = [];
    let dmxIdentical = true;
    for (let f = 0; f < 60; f++) {
      const flip = Math.floor((f * 25) / 50) % 2 === 0;
      probe.patchShowState({
        primaryColor: flip ? '#ff0000' : '#00f0ff',
        accentColor: flip ? '#ff0055' : '#0044ff',
      });
      const stepLit = probe.stepAndReadLuminance(25);
      frames.push({ timeMs: stepLit.elapsedMs, grid: stepLit.grid });
      if (!Array.isArray(stepLit.physicalDmxU1) || stepLit.physicalDmxU1.length !== 512) {
        dmxIdentical = false;
      }
    }

    const countSeries = (extract) => {
      const genTimes = [];
      const redTimes = [];
      let anchorY = extract(frames[0]).y;
      let lastGenDir = 0;
      let anchorRed = extract(frames[0]);
      let lastRedDir = 0;
      for (let i = 1; i < frames.length; i++) {
        const t = frames[i].timeMs;
        const m = extract(frames[i]);
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
    for (let c = 0; c < frames[0].grid.cells.length; c++) {
      const r = countSeries((s) => s.grid.cells[c]);
      if (r.gen > maxGen) maxGen = r.gen;
      if (r.red > maxRed) maxRed = r.red;
    }

    return {
      baseline,
      afterToggles,
      preLossMeanByte: meanByte(preLossImg),
      postRestoreFullMeanByte: meanByte(postRestoreFullImg),
      postRestorePuffsMeanByte: meanByte(postRestorePuffsImg),
      postRestoreActive: postRestoreProbe.litPuffs.active,
      maxGen,
      maxRed,
      dmxIdentical,
    };
  });

  // Verify real WebGL1 context compiles & links VAPOR_VERT_LIT + VAPOR_FRAG_LIT cleanly on the GPU driver
  const webgl1Compile = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const gl1 = c.getContext('webgl');
    if (!gl1) return { supported: false, linked: true, log: '' };
    const vertSrc = `
      precision highp float;
      uniform mat4 modelViewMatrix;
      uniform mat4 projectionMatrix;
      attribute vec3 position;
      attribute vec3 center, shape;
      attribute vec3 broadLight, lobeLight;
      attribute vec4 lobeOffset;
      uniform float aspect;
      varying vec2 texUv;
      varying float density;
      varying vec3 vBroadLight;
      varying vec3 vLobeLight;
      varying vec3 vLobeUvAndConc;
      void main() {
        texUv = position.xy + 0.5;
        float safeDiam = max(shape.x, 0.05);
        vec2 quadScale = vec2(aspect, 1.0) * safeDiam;
        vec2 offset = position.xy * quadScale;
        float c = cos(shape.y), s = sin(shape.y);
        vec4 eye = modelViewMatrix * vec4(center, 1.0);
        float nearFade = smoothstep(0.35, 2.05, -eye.z);
        density = shape.z * nearFade;
        vBroadLight = broadLight;
        vLobeLight = lobeLight;
        vec2 lobeEye = (modelViewMatrix * vec4(lobeOffset.xyz, 0.0)).xy;
        vec2 unrot = mat2(c, -s, s, c) * lobeEye;
        vec2 lobeUv = clamp(unrot / quadScale, vec2(-0.65), vec2(0.65));
        vLobeUvAndConc = vec3(lobeUv, max(0.0, lobeOffset.w));
        eye.xy += mat2(c, s, -s, c) * offset;
        gl_Position = projectionMatrix * eye;
      }
    `;
    const fragSrc = `
      precision highp float;
      uniform sampler2D vapor;
      uniform vec3 tint;
      varying vec2 texUv;
      varying float density;
      varying vec3 vBroadLight;
      varying vec3 vLobeLight;
      varying vec3 vLobeUvAndConc;
      void main() {
        vec4 cloud = texture2D(vapor, texUv);
        float alpha = density * cloud.a;
        if (alpha < 0.001) discard;
        vec3 baseCol = tint * cloud.r;
        vec2 uvDelta = (texUv - 0.5) - vLobeUvAndConc.xy;
        float lobeMask = exp(-vLobeUvAndConc.z * dot(uvDelta, uvDelta));
        float cloudBody = 0.42 + 0.78 * cloud.r;
        vec3 added = (vBroadLight + vLobeLight * lobeMask) * cloudBody;
        float peak = max(added.r, max(added.g, added.b));
        if (peak > 1e-5) {
          float comp = 0.68 * (peak / (peak + 0.48));
          added *= min(1.0, comp / peak);
        }
        gl_FragColor = vec4(baseCol + added, alpha);
      }
    `;
    const compile = (type, src) => {
      const sh = gl1.createShader(type);
      gl1.shaderSource(sh, src);
      gl1.compileShader(sh);
      return { sh, ok: Boolean(gl1.getShaderParameter(sh, gl1.COMPILE_STATUS)), log: gl1.getShaderInfoLog(sh) || '' };
    };
    const vs = compile(gl1.VERTEX_SHADER, vertSrc);
    const fs = compile(gl1.FRAGMENT_SHADER, fragSrc);
    const prog = gl1.createProgram();
    gl1.attachShader(prog, vs.sh);
    gl1.attachShader(prog, fs.sh);
    gl1.linkProgram(prog);
    const linked = Boolean(vs.ok && fs.ok && gl1.getProgramParameter(prog, gl1.LINK_STATUS));
    const log = `${vs.log}${fs.log}${gl1.getProgramInfoLog(prog) || ''}`;
    gl1.deleteProgram(prog);
    gl1.deleteShader(vs.sh);
    gl1.deleteShader(fs.sh);
    gl1.getExtension('WEBGL_lose_context')?.loseContext();
    return { supported: true, linked, log };
  });
  expect(webgl1Compile.linked).toBe(true);
  expect(webgl1Compile.log).toBe('');

  expect(lifecycleAndFlash.afterToggles.geometries).toBe(lifecycleAndFlash.baseline.geometries);
  expect(lifecycleAndFlash.afterToggles.textures).toBe(lifecycleAndFlash.baseline.textures);
  expect(lifecycleAndFlash.postRestoreActive).toBe(true);
  expect(lifecycleAndFlash.postRestorePuffsMeanByte).toBeGreaterThan(4.0);
  expect(lifecycleAndFlash.postRestoreFullMeanByte).toBeGreaterThan(lifecycleAndFlash.preLossMeanByte * 0.85);
  expect(lifecycleAndFlash.dmxIdentical).toBe(true);
  expect(lifecycleAndFlash.maxGen).toBeLessThanOrEqual(3);
  expect(lifecycleAndFlash.maxRed).toBeLessThanOrEqual(3);

  expect(errors).toEqual([]);
});

test('Sprint 20: Desktop & 390x844 phone-like warmed A/B benchmarks, low-tier caps, 44px touch target & persistence', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' || /THREE\.WebGLProgram/i.test(msg.text())) errors.push(msg.text());
  });

  // 1. Desktop 1280x720 high-tier warmed benchmark (16 candidates, <= 4 beams/puff)
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.measureFrames)).toBe('function');
  await playSynthDemo(page);
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await page.evaluate(() => {
    const p = window.stageforgeProbe;
    p.patchShowState({
      autoDirector: false,
      blackout: false,
      masterDimmer: 1,
      beamIntensity: 1,
      washIntensity: 1,
      atmo: { hazeLevel: 0.35, smokeOutput: 1.0, co2Active: true },
    });
    p.resetParticles(4242);
    for (let i = 0; i < 20; i++) p.stepAndReadLuminance(120);
    p.setRenderSettings({ litPuffs: true });
    p.redrawAndCapture();
    p.setRenderSettings({ litPuffs: false });
    p.redrawAndCapture();
  });
  await waitFrames(page, 4);
  const desktopOff = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 10, sampleFrames: 30, gpu: true }),
  );
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ litPuffs: true }));
  await waitFrames(page, 4);
  const desktopOn = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 10, sampleFrames: 30, gpu: true }),
  );
  const desktopProbeOn = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(Math.round(desktopOn.meanCalls)).toBe(Math.round(desktopOff.meanCalls));

  // 2. Phone-like 390x844 + 4x CPU throttle low-tier warmed benchmark (8 candidates, <= 2 beams/puff)
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.removeItem('stageforge.render.v1'));
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.measureFrames)).toBe('function');
  await playSynthDemo(page);
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await page.evaluate(() => {
    const p = window.stageforgeProbe;
    p.patchShowState({
      autoDirector: false,
      blackout: false,
      masterDimmer: 1,
      beamIntensity: 1,
      washIntensity: 1,
      atmo: { hazeLevel: 0.35, smokeOutput: 1.0, co2Active: true },
    });
    p.resetParticles(4242);
    for (let i = 0; i < 20; i++) p.stepAndReadLuminance(120);
    p.setRenderSettings({ litPuffs: true });
    p.redrawAndCapture();
    p.setRenderSettings({ litPuffs: false });
    p.redrawAndCapture();
  });
  await waitFrames(page, 4);
  const phoneOff = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 8, sampleFrames: 24, gpu: true }),
  );
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ litPuffs: true }));
  await waitFrames(page, 4);
  const phoneOn = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 8, sampleFrames: 24, gpu: true }),
  );
  const phoneProbeOn = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  expect(Math.round(phoneOn.meanCalls)).toBe(Math.round(phoneOff.meanCalls));

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ litPuffs: false }));
  await waitFrames(page, 3);

  // Toggle via Display & safety popover on 390x844 mobile viewport
  await page.getByTestId('display-settings-toggle').click();
  const panel = page.getByTestId('display-settings-panel');
  await expect(panel).toBeVisible();

  const checkbox = page.getByTestId('render-lit-puffs-checkbox');
  await checkbox.scrollIntoViewIfNeeded();
  await expect(checkbox).toBeChecked({ checked: false });

  const labelBox = await checkbox.locator('..').boundingBox();
  expect(labelBox.height).toBeGreaterThanOrEqual(44);
  const panelBox = await panel.boundingBox();
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(390.5);
  expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(844.5);

  const overflowX = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflowX).toBeLessThanOrEqual(0);

  await checkbox.check();
  await expect(checkbox).toBeChecked();

  const lowProbe = await page.evaluate(() => ({
    probe: window.stageforgeProbe.graphicsProbe(),
    stored: JSON.parse(localStorage.getItem('stageforge.render.v1') || '{}'),
  }));
  expect(lowProbe.stored.litPuffs).toBe(true);
  expect(lowProbe.probe.litPuffs.active).toBe(true);
  expect(lowProbe.probe.litPuffs.tier).toBe('low');
  expect(lowProbe.probe.litPuffs.candidateCap).toBe(8);
  expect(lowProbe.probe.litPuffs.beamsPerPuffCap).toBe(2);
  expect(lowProbe.probe.litPuffs.extraBufferBytes).toBe(12_000);
  expect(lowProbe.probe.particles.smoke.capacity).toBe(120);
  expect(lowProbe.probe.particles.cryo.capacity).toBe(180);

  // Reload and confirm boot-enabled true -> false -> true cycle works cleanly
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.graphicsProbe)).toBe('function');
  const bootEnabledCycle = await page.evaluate(() => {
    const probe = window.stageforgeProbe;
    probe.setCameraPose([0, 3.6, 17.5], [0, 2.4, 2.5]);
    const bootedOn = probe.graphicsProbe().settings.litPuffs && probe.graphicsProbe().litPuffs.active;
    probe.redrawAndCapture();
    probe.setRenderSettings({ litPuffs: false });
    probe.redrawAndCapture();
    const toggledOff = !probe.graphicsProbe().litPuffs.active;
    probe.setRenderSettings({ litPuffs: true });
    probe.redrawAndCapture();
    const toggledBackOn = probe.graphicsProbe().litPuffs.active;
    return { bootedOn, toggledOff, toggledBackOn };
  });
  expect(bootEnabledCycle).toEqual({ bootedOn: true, toggledOff: true, toggledBackOn: true });

  console.log('[SPRINT20_PROBE_SUMMARY]', JSON.stringify({
    desktop1280x720: {
      callsOff: Math.round(desktopOff.meanCalls),
      callsOn: Math.round(desktopOn.meanCalls),
      cpuP50Off: +desktopOff.cpuTotalMs.p50.toFixed(3),
      cpuP50On: +desktopOn.cpuTotalMs.p50.toFixed(3),
      cpuDeltaMs: +(desktopOn.cpuTotalMs.p50 - desktopOff.cpuTotalMs.p50).toFixed(3),
      particlesMeanOff: +desktopOff.particlesMs.mean.toFixed(3),
      particlesMeanOn: +desktopOn.particlesMs.mean.toFixed(3),
      renderSubmitMeanOff: +desktopOff.renderSubmitMs.mean.toFixed(3),
      renderSubmitMeanOn: +desktopOn.renderSubmitMs.mean.toFixed(3),
      frameP50Off: +desktopOff.frameIntervalMs.p50.toFixed(2),
      frameP50On: +desktopOn.frameIntervalMs.p50.toFixed(2),
      frameP95Off: +desktopOff.frameIntervalMs.p95.toFixed(2),
      frameP95On: +desktopOn.frameIntervalMs.p95.toFixed(2),
      gpuP50Off: desktopOff.gpuMs.count > 0 ? +desktopOff.gpuMs.p50.toFixed(3) : null,
      gpuP50On: desktopOn.gpuMs.count > 0 ? +desktopOn.gpuMs.p50.toFixed(3) : null,
      litPuffs: desktopProbeOn.litPuffs,
    },
    phone390x844_4xCpu: {
      callsOff: Math.round(phoneOff.meanCalls),
      callsOn: Math.round(phoneOn.meanCalls),
      cpuP50Off: +phoneOff.cpuTotalMs.p50.toFixed(3),
      cpuP50On: +phoneOn.cpuTotalMs.p50.toFixed(3),
      cpuDeltaMs: +(phoneOn.cpuTotalMs.p50 - phoneOff.cpuTotalMs.p50).toFixed(3),
      particlesMeanOff: +phoneOff.particlesMs.mean.toFixed(3),
      particlesMeanOn: +phoneOn.particlesMs.mean.toFixed(3),
      renderSubmitMeanOff: +phoneOff.renderSubmitMs.mean.toFixed(3),
      renderSubmitMeanOn: +phoneOn.renderSubmitMs.mean.toFixed(3),
      frameP50Off: +phoneOff.frameIntervalMs.p50.toFixed(2),
      frameP50On: +phoneOn.frameIntervalMs.p50.toFixed(2),
      frameP95Off: +phoneOff.frameIntervalMs.p95.toFixed(2),
      frameP95On: +phoneOn.frameIntervalMs.p95.toFixed(2),
      gpuP50Off: phoneOff.gpuMs.count > 0 ? +phoneOff.gpuMs.p50.toFixed(3) : null,
      gpuP50On: phoneOn.gpuMs.count > 0 ? +phoneOn.gpuMs.p50.toFixed(3) : null,
      litPuffs: phoneProbeOn.litPuffs,
    },
  }));

  expect(errors).toEqual([]);
});
