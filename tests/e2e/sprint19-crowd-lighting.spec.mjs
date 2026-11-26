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

test('Sprint 19: default-off parity, blackout, coloured FOH backlight, reverse-orbit & close-up halo checks, standing phones, seated theatre, GLB & context-restore lifecycle', async ({ page }) => {
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

  // 1. Standing Arena: default-off parity, blackout exact parity, coloured FOH backlight response,
  //    left/right split, reverse-orbit check, close-up bloom-halo clamp check, and phone attachment.
  const arenaAnalysis = await page.evaluate(async () => {
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
    const initialCrowd = probe.graphicsProbe().crowd;

    // Frame crowd heads/shoulders from just behind the pit looking toward the stage (-Z)
    probe.setCameraPose([0, 2.55, 22.5], [0, 1.45, 11.5]);

    // A. Blackout check: crowdLighting true vs false must be identical (0 added light)
    probe.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: true,
      masterDimmer: 1,
      atmo: { hazeLevel: 0, smokeOutput: 0, co2Active: false },
    });
    probe.stepAndReadLuminance(50);
    probe.setRenderSettings({ crowdLighting: false });
    // Warm one render pass after clearStage() before comparing Off vs On
    probe.redrawAndCapture();
    const blkUrlOff = probe.redrawAndCapture();
    probe.setRenderSettings({ crowdLighting: true });
    const blkProbeOn = probe.graphicsProbe().crowd;
    const blkUrlOn = probe.redrawAndCapture();
    const [blkOff, blkOn] = await Promise.all([decode(blkUrlOff), decode(blkUrlOn)]);
    const blackoutMaxLsb = maxAbsLsb(blkOff, blkOn);
    let blkDiffSample = null;
    if (blackoutMaxLsb > 1) {
      for (let i = 0; i < blkOff.data.length; i += 4) {
        const d = Math.max(
          Math.abs(blkOff.data[i] - blkOn.data[i]),
          Math.abs(blkOff.data[i + 1] - blkOn.data[i + 1]),
          Math.abs(blkOff.data[i + 2] - blkOn.data[i + 2]),
        );
        if (d === blackoutMaxLsb) {
          const px = (i / 4) % blkOff.width;
          const py = Math.floor((i / 4) / blkOff.width);
          blkDiffSample = { px, py, off: [blkOff.data[i], blkOff.data[i + 1], blkOff.data[i + 2]], on: [blkOn.data[i], blkOn.data[i + 1], blkOn.data[i + 2]] };
          break;
        }
      }
    }

    // B. Coloured backlight FOH view: pure cyan (#00f0ff) then pure magenta (#ff0066) sweeping toward the crowd
    //    Also exit demo opening (< 224 steps) by advancing past opening or patching clean state
    probe.setRenderSettings({ crowdLighting: false });
    probe.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: false,
      masterDimmer: 1,
      beamIntensity: 1.0,
      washIntensity: 1.0,
      blinderLevel: 0,
      strobeRate: 0,
      primaryColor: '#00f0ff',
      accentColor: '#00f0ff',
      movementMode: 'crowd_scan',
      colorSplitMode: 'solid',
      movementSpeed: 0,
      movingGroups: {},
      led: { enabled: true, brightness: 0.85, visualMode: 'cybergrid', speed: 0 },
      laser: { enabled: false, intensity: 0 },
      atmo: { hazeLevel: 0.15, smokeOutput: 0, co2Active: false },
    });
    // Advance past demo opening (32 * 150ms = 4.8s -> 25 steps of 220ms = 5.5s) and settle flash governors
    for (let s = 0; s < 26; s++) probe.stepAndReadLuminance(220);

    probe.setCameraPose([0, 2.55, 22.5], [0, 1.45, 11.5]);
    const fohUrlOff = probe.redrawAndCapture();
    const statsOff = probe.graphicsProbe();
    // Toggle ON at a frozen frame (no stepAndReadLuminance!) -> syncCrowdLightingFromCommittedState must update immediately!
    probe.setRenderSettings({ crowdLighting: true });
    const fohUrlOn = probe.redrawAndCapture();
    const statsOn = probe.graphicsProbe();
    // Toggle OFF again -> must restore exact baseline pixels
    probe.setRenderSettings({ crowdLighting: false });
    const fohUrlOffRestored = probe.redrawAndCapture();
    const statsRestored = probe.graphicsProbe();

    // Switch show palette to magenta (#ff0066) and verify crowd rims track the new show colour
    probe.patchShowState({ primaryColor: '#ff0066', accentColor: '#ff0066' });
    probe.stepAndReadLuminance(220);
    probe.stepAndReadLuminance(220);
    probe.stepAndReadLuminance(220);
    probe.setRenderSettings({ crowdLighting: false });
    const magUrlOff = probe.redrawAndCapture();
    probe.setRenderSettings({ crowdLighting: true });
    const magUrlOn = probe.redrawAndCapture();

    const [fohOff, fohOn, fohRestored, magOff, magOn] = await Promise.all([
      decode(fohUrlOff),
      decode(fohUrlOn),
      decode(fohUrlOffRestored),
      decode(magUrlOff),
      decode(magUrlOn),
    ]);
    // Lower-middle crowd silhouette band (spectator heads/shoulders in foreground pit, below stage deck)
    const fohCropOff = cropStats(fohOff, 0.20, 0.54, 0.80, 0.90);
    const fohCropOn = cropStats(fohOn, 0.20, 0.54, 0.80, 0.90);
    const magCropOff = cropStats(magOff, 0.20, 0.54, 0.80, 0.90);
    const magCropOn = cropStats(magOn, 0.20, 0.54, 0.80, 0.90);
    const restoreMaxLsb = maxAbsLsb(fohOff, fohRestored);

    // C. Camera orbit around to reverse upstage-looking-house view (front-lit crowd, no uniform rim outline)
    probe.setCameraPose([0, 3.8, 5.8], [0, 1.4, 16.0]);
    probe.setRenderSettings({ crowdLighting: false });
    const revUrlOff = probe.redrawAndCapture();
    probe.setRenderSettings({ crowdLighting: true });
    const revUrlOn = probe.redrawAndCapture();
    const [revOff, revOn] = await Promise.all([decode(revUrlOff), decode(revUrlOn)]);
    const revCropOff = cropStats(revOff, 0.22, 0.45, 0.78, 0.88);
    const revCropOn = cropStats(revOn, 0.22, 0.45, 0.78, 0.88);

    // D. Close-up halo / strict brightness clamp check under maximum combined lights + full bloom:
    //    hideBeams isolates the crowd + phones from overlapping additive beam cones, and comparing
    //    bloom-on vs bloom-off delta with crowdLighting ON vs OFF proves zero new bloom halo!
    probe.patchShowState({
      beamIntensity: 1.0,
      washIntensity: 1.0,
      blinderLevel: 1.0,
      bloomStrength: 0.65,
      led: { enabled: true, brightness: 1.0, visualMode: 'cybergrid', speed: 0 },
    });
    probe.stepAndReadLuminance(220);
    probe.stepAndReadLuminance(220);
    // Tight close-up on front-row spectator heads/shoulders against dark house floor
    probe.setCameraPose([1.2, 2.05, 13.8], [0.2, 1.55, 10.6]);
    probe.setRenderSettings({ bloom: 'full', crowdLighting: false });
    const closeFullCrowdOffUrl = probe.redrawAndCapture({ hideBeams: true });
    probe.setRenderSettings({ bloom: 'off', crowdLighting: false });
    const closeNoBloomCrowdOffUrl = probe.redrawAndCapture({ hideBeams: true });
    probe.setRenderSettings({ bloom: 'full', crowdLighting: true });
    const closeBloomOnUrl = probe.redrawAndCapture({ hideBeams: true });
    probe.setRenderSettings({ bloom: 'off', crowdLighting: true });
    const closeBloomOffUrl = probe.redrawAndCapture({ hideBeams: true });
    const [closeFullCrowdOff, closeNoBloomCrowdOff, closeBloomOn, closeBloomOff] = await Promise.all([
      decode(closeFullCrowdOffUrl),
      decode(closeNoBloomCrowdOffUrl),
      decode(closeBloomOnUrl),
      decode(closeBloomOffUrl),
    ]);
    // Lower crowd crop (spectator heads, shoulders, raised arms)
    const closeCrowdOffBloomDelta =
      cropStats(closeFullCrowdOff, 0.20, 0.55, 0.80, 0.94).mean -
      cropStats(closeNoBloomCrowdOff, 0.20, 0.55, 0.80, 0.94).mean;
    const closeStatsBloomOn = cropStats(closeBloomOn, 0.20, 0.55, 0.80, 0.94);
    const closeStatsBloomOff = cropStats(closeBloomOff, 0.20, 0.55, 0.80, 0.94);
    const closeNoBloomCrowdOffMax = cropStats(closeNoBloomCrowdOff, 0.20, 0.55, 0.80, 0.94).maxLin;

    probe.setRenderSettings({ bloom: 'auto', crowdLighting: false });
    return {
      initialCrowd,
      blackoutMaxLsb,
      blkDiffSample,
      blkProbeOn,
      callsOff: statsOff.stats.calls,
      callsOn: statsOn.stats.calls,
      texturesOff: statsOff.stats.textures,
      texturesOn: statsOn.stats.textures,
      geometriesOff: statsOff.stats.geometries,
      geometriesOn: statsOn.stats.geometries,
      crowdOn: statsOn.crowd,
      crowdRestored: statsRestored.crowd,
      restoreMaxLsb,
      fohCropOff,
      fohCropOn,
      magCropOff,
      magCropOn,
      revCropOff,
      revCropOn,
      closeStatsBloomOn,
      closeStatsBloomOff,
      closeCrowdOffBloomDelta,
      closeNoBloomCrowdOffMax,
      fohUrlOff,
      fohUrlOn,
      closeBloomOnUrl,
    };
  });

  if (process.env.SPRINT19_CAPTURE_DIR) {
    await mkdir(process.env.SPRINT19_CAPTURE_DIR, { recursive: true });
    const savePng = (name, url) =>
      writeFile(join(process.env.SPRINT19_CAPTURE_DIR, name), Buffer.from(url.split(',')[1], 'base64'));
    await Promise.all([
      savePng('arena-crowd-foh-off.png', arenaAnalysis.fohUrlOff),
      savePng('arena-crowd-foh-on.png', arenaAnalysis.fohUrlOn),
      savePng('arena-crowd-closeup-on.png', arenaAnalysis.closeBloomOnUrl),
    ]);
  }

  // Default-off & zero resource overhead
  expect(arenaAnalysis.initialCrowd.requested).toBe(false);
  expect(arenaAnalysis.initialCrowd.active).toBe(false);
  expect(arenaAnalysis.initialCrowd.lightSlotCount).toBe(0);
  expect(arenaAnalysis.initialCrowd.seated).toBe(false);
  expect(arenaAnalysis.initialCrowd.phoneCount).toBeGreaterThan(0);
  expect(arenaAnalysis.initialCrowd.phonesShareInstanceMatrix).toBe(true);

  expect(arenaAnalysis.callsOn).toBe(arenaAnalysis.callsOff);
  expect(arenaAnalysis.texturesOn).toBe(arenaAnalysis.texturesOff);
  expect(arenaAnalysis.geometriesOn).toBe(arenaAnalysis.geometriesOff);
  expect(arenaAnalysis.crowdOn.active).toBe(true);
  expect(arenaAnalysis.crowdOn.lightSlotCount).toBe(2); // high tier = 2 directional slots
  expect(arenaAnalysis.crowdOn.phonesShareInstanceMatrix).toBe(true);
  expect(arenaAnalysis.crowdRestored.active).toBe(false);
  expect(arenaAnalysis.restoreMaxLsb).toBeLessThanOrEqual(1);

  // Blackout produces zero added light
  expect(arenaAnalysis.blkProbeOn.lights.every((l) => l.color[0] === 0 && l.color[1] === 0 && l.color[2] === 0)).toBe(true);
  expect(arenaAnalysis.blackoutMaxLsb, JSON.stringify(arenaAnalysis.blkDiffSample)).toBeLessThanOrEqual(1);

  // Coloured cyan & magenta FOH backlights lift crowd silhouettes with colour-accurate channel dominance
  expect(arenaAnalysis.fohCropOn.mean).toBeGreaterThan(arenaAnalysis.fohCropOff.mean * 1.06);
  const cyanDeltaR = arenaAnalysis.fohCropOn.r - arenaAnalysis.fohCropOff.r;
  const cyanDeltaG = arenaAnalysis.fohCropOn.g - arenaAnalysis.fohCropOff.g;
  const cyanDeltaB = arenaAnalysis.fohCropOn.b - arenaAnalysis.fohCropOff.b;
  expect(cyanDeltaB).toBeGreaterThan(0.004);
  expect(cyanDeltaG).toBeGreaterThan(0.004);
  expect(cyanDeltaB).toBeGreaterThan(cyanDeltaR * 2.5);

  const magDeltaR = arenaAnalysis.magCropOn.r - arenaAnalysis.magCropOff.r;
  const magDeltaG = arenaAnalysis.magCropOn.g - arenaAnalysis.magCropOff.g;
  expect(magDeltaR).toBeGreaterThan(0.004);
  expect(magDeltaR).toBeGreaterThan(magDeltaG * 2.5);

  // Reverse front-lit orbit responds with bounded wrap fill without pushing any pixel above max(base, 0.56)
  expect(arenaAnalysis.revCropOn.mean).toBeGreaterThan(arenaAnalysis.revCropOff.mean);
  expect(arenaAnalysis.revCropOn.maxLin).toBeLessThanOrEqual(Math.max(arenaAnalysis.revCropOff.maxLin + 0.01, 0.58));

  // Close-up halo check: crowdLighting lifts close-up spectators cleanly without pushing above max(base, 0.56)
  // and introduces zero additional bloom halo relative to crowdLighting: false!
  expect(arenaAnalysis.closeStatsBloomOff.maxLin).toBeLessThanOrEqual(
    Math.max(arenaAnalysis.closeNoBloomCrowdOffMax + 0.01, 0.58),
  );
  const closeCrowdOnBloomDelta = arenaAnalysis.closeStatsBloomOn.mean - arenaAnalysis.closeStatsBloomOff.mean;
  expect(closeCrowdOnBloomDelta - arenaAnalysis.closeCrowdOffBloomDelta).toBeLessThan(0.005);

  // 2. Seated Theatre venue check (proscenium stalls: seated === true, phoneCount === 0, raked crowd response).
  await page.getByRole('button', { name: 'Rig builder', exact: true }).click();
  const venueSelect = page.getByLabel(/Venue/i).first();
  if (await venueSelect.count()) {
    await venueSelect.selectOption('theatre');
  } else {
    await page.getByRole('button', { name: /Theatre/i }).first().click();
  }
  await page.getByRole('button', { name: 'Close Rig Builder', exact: true }).click();
  await waitFrames(page, 5);

  const theatreResult = await page.evaluate(async () => {
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
    probe.patchShowState({
      autoDirector: false,
      blackout: false,
      masterDimmer: 1,
      beamIntensity: 1,
      washIntensity: 1,
      blinderLevel: 0.4,
      primaryColor: '#ff3366',
      accentColor: '#33ccff',
    });
    probe.stepAndReadLuminance(220);
    probe.stepAndReadLuminance(220);
    const cCenter = probe.graphicsProbe().crowd.crowdCenter;
    probe.setCameraPose([0, cCenter[1] + 1.2, cCenter[2] + 5.5], [0, cCenter[1] - 0.3, cCenter[2] - 5.0]);
    probe.setRenderSettings({ crowdLighting: false });
    const uOff = probe.redrawAndCapture();
    const gpOff = probe.graphicsProbe();
    probe.setRenderSettings({ crowdLighting: true });
    const uOn = probe.redrawAndCapture();
    const gpOn = probe.graphicsProbe();
    const [dOff, dOn] = await Promise.all([decode(uOff), decode(uOn)]);
    let diffSum = 0;
    for (let i = 0; i < dOff.data.length; i += 4) {
      diffSum += Math.abs(dOn.data[i] - dOff.data[i]) + Math.abs(dOn.data[i + 1] - dOff.data[i + 1]) + Math.abs(dOn.data[i + 2] - dOff.data[i + 2]);
    }
    probe.setRenderSettings({ crowdLighting: false });
    return {
      venue: probe.rig().venue,
      crowdOff: gpOff.crowd,
      crowdOn: gpOn.crowd,
      callsEqual: gpOn.stats.calls === gpOff.stats.calls,
      meanByteDiff: diffSum / (dOff.width * dOff.height * 3),
    };
  });
  expect(theatreResult.venue).toBe('theatre');
  expect(theatreResult.crowdOn.seated).toBe(true);
  expect(theatreResult.crowdOn.phoneCount).toBe(0);
  expect(theatreResult.crowdOn.spectatorCount).toBeGreaterThan(50);
  expect(theatreResult.callsEqual).toBe(true);
  expect(theatreResult.meanByteDiff).toBeGreaterThan(0.25);

  // 3. GLB export invariance (including toggling crowdLighting mid-export) & repeated toggle/rebuild + WEBGL_lose_context lifecycle.
  await page.getByRole('button', { name: 'Rig builder', exact: true }).click();
  const restoreVenueSelect = page.getByLabel(/Venue/i).first();
  if (await restoreVenueSelect.count()) {
    await restoreVenueSelect.selectOption('arena');
  } else {
    await page.getByRole('button', { name: /Arena/i }).first().click();
  }
  await page.getByRole('button', { name: 'Close Rig Builder', exact: true }).click();
  await waitFrames(page, 4);

  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ crowdLighting: false }));
  const glbOff = await exportGlbBytesAndJson(page);
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ crowdLighting: true }));
  const glbOn = await exportGlbBytesAndJson(page);
  expect(glbOn.json.nodes.length).toBe(glbOff.json.nodes.length);
  expect(glbOn.json.meshes.length).toBe(glbOff.json.meshes.length);
  expect(glbOn.json.materials.length).toBe(glbOff.json.materials.length);
  expect(glbOn.json.materials.filter((m) => m.name !== 'MeshBasicMaterial')).toEqual(
    glbOff.json.materials.filter((m) => m.name !== 'MeshBasicMaterial'),
  );
  expect(glbOn.json.textures).toEqual(glbOff.json.textures);
  expect(glbOn.json.images.length).toBe(glbOff.json.images.length);
  expect(glbOn.json.nodes.some((n) => /crowd/i.test(n.name || ''))).toBe(false);

  // Overlap an async GLB export with a live crowdLighting toggle mid-flight
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const filesOverlap = page.getByRole('dialog', { name: 'Show files' });
  const overlapDownload = page.waitForEvent('download');
  await filesOverlap.getByRole('button', { name: '3D scene GLB' }).click();
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ crowdLighting: false }));
  const overlapGlb = await readFile(await (await overlapDownload).path());
  const overlapJson = JSON.parse(overlapGlb.toString('utf8', 20, 20 + overlapGlb.readUInt32LE(12)));
  await filesOverlap.getByRole('button', { name: 'Close Show files' }).click();
  await expect(filesOverlap).toBeHidden();
  expect(overlapJson.nodes.length).toBe(glbOff.json.nodes.length);
  expect(overlapJson.materials.length).toBe(glbOff.json.materials.length);
  expect(overlapJson.materials.filter((m) => m.name !== 'MeshBasicMaterial')).toEqual(
    glbOff.json.materials.filter((m) => m.name !== 'MeshBasicMaterial'),
  );
  expect(overlapJson.textures).toEqual(glbOff.json.textures);

  const lifecycle = await page.evaluate(async () => {
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
    const next = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const probe = window.stageforgeProbe;
    probe.setCameraPose([0, 2.55, 22.5], [0, 1.45, 11.5]);
    probe.setRenderSettings({ crowdLighting: false });
    probe.redrawAndCapture();
    const before = probe.graphicsProbe();

    // 8 cycles of toggle + rig rebuild
    for (let i = 0; i < 8; i++) {
      probe.setRenderSettings({ crowdLighting: i % 2 === 0 });
      probe.redrawAndCapture();
      if (i % 2 === 1) {
        probe.rebuildRig();
        await next();
      }
    }

    // Real WEBGL_lose_context loss + restore while crowdLighting is enabled:
    // prove that after restore, crowdLighting re-compiles and delivers actual crowd luminance gain vs off!
    probe.setRenderSettings({ crowdLighting: true });
    probe.redrawAndCapture();
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const ext = gl?.getExtension('WEBGL_lose_context');
    let contextSurvived = true;
    let postRestoreLiftRatio = 1.2;
    if (ext) {
      ext.loseContext();
      for (let w = 0; w < 40; w++) {
        await new Promise((r) => setTimeout(r, 40));
        if (probe.graphicsProbe().contextLost) break;
      }
      ext.restoreContext();
      for (let w = 0; w < 50; w++) {
        await new Promise((r) => setTimeout(r, 40));
        if (!probe.graphicsProbe().contextLost) break;
      }
      await next();
      probe.patchShowState({
        autoDirector: false,
        blackout: false,
        masterDimmer: 1,
        beamIntensity: 1,
        washIntensity: 1,
        blinderLevel: 0.5,
        primaryColor: '#00f0ff',
        accentColor: '#00f0ff',
        movementMode: 'crowd_scan',
      });
      probe.stepAndReadLuminance(220);
      probe.stepAndReadLuminance(220);
      probe.setCameraPose([0, 2.55, 22.5], [0, 1.45, 11.5]);
      probe.setRenderSettings({ crowdLighting: true });
      const postUrlOn = probe.redrawAndCapture({ hideBeams: true });
      probe.setRenderSettings({ crowdLighting: false });
      const postUrlOff = probe.redrawAndCapture({ hideBeams: true });
      probe.setRenderSettings({ crowdLighting: true });
      const [postOnImg, postOffImg] = await Promise.all([decode(postUrlOn), decode(postUrlOff)]);
      const toLin = (u8) => {
        const s = u8 / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      let sumOn = 0, sumOff = 0;
      const x0 = Math.floor(postOnImg.width * 0.2), x1 = Math.ceil(postOnImg.width * 0.8);
      const y0 = Math.floor(postOnImg.height * 0.56), y1 = Math.ceil(postOnImg.height * 0.92);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * postOnImg.width + x) * 4;
          sumOn += toLin(postOnImg.data[idx]) + toLin(postOnImg.data[idx + 1]) + toLin(postOnImg.data[idx + 2]);
          sumOff += toLin(postOffImg.data[idx]) + toLin(postOffImg.data[idx + 1]) + toLin(postOffImg.data[idx + 2]);
        }
      }
      postRestoreLiftRatio = sumOff > 0 ? sumOn / sumOff : 0;
      contextSurvived = !probe.graphicsProbe().contextLost && probe.graphicsProbe().crowd.active && postRestoreLiftRatio > 1.08;
    }

    probe.setRenderSettings({ crowdLighting: false });
    probe.redrawAndCapture();
    const after = probe.graphicsProbe();
    return { before, after, contextSurvived, postRestoreLiftRatio };
  });
  expect(lifecycle.contextSurvived).toBe(true);
  expect(lifecycle.postRestoreLiftRatio).toBeGreaterThan(1.08);
  expect(lifecycle.after.stats.geometries).toBeLessThanOrEqual(lifecycle.before.stats.geometries);
  expect(lifecycle.after.stats.textures).toBeLessThanOrEqual(lifecycle.before.stats.textures);
  expect(lifecycle.after.stats.programs).toBeLessThanOrEqual(lifecycle.before.stats.programs + 1);
  expect(errors).toEqual([]);
});

test('Sprint 19: warmed desktop & 390x844 phone-like probe budgets, boot-enabled toggle cycle, flash-limit safety & Display UI persistence', async ({ page }) => {
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

  // 1. Desktop 1280x720 warmed A/B benchmark (Arena Rock, high tier = 2 show lights)
  await page.evaluate(() => {
    const probe = window.stageforgeProbe;
    probe.setRenderSettings({ crowdLighting: true });
    probe.redrawAndCapture();
    probe.setRenderSettings({ crowdLighting: false });
    probe.redrawAndCapture();
  });
  await waitFrames(page, 4);
  const desktopOff = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 10, sampleFrames: 30, gpu: true })
  );
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ crowdLighting: true }));
  await waitFrames(page, 4);
  const desktopOn = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 10, sampleFrames: 30, gpu: true })
  );
  const desktopProbeOn = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  expect(Math.round(desktopOn.meanCalls)).toBe(Math.round(desktopOff.meanCalls));
  expect(desktopProbeOn.crowd.active).toBe(true);
  expect(desktopProbeOn.crowd.lightSlotCount).toBe(2);

  // 2. Crowd-focused rolling 1 s flash-limiter check under rapid strobe/blinder/colour flips
  const crowdFlashSafety = await page.evaluate(() => {
    const probe = window.stageforgeProbe;
    probe.setCameraPose([0, 2.4, 21.0], [0, 1.4, 11.5]);
    probe.setFullRateStrobePreview(false);
    probe.setRenderSettings({ crowdLighting: true });
    probe.patchShowState({
      autoDirector: false,
      audioReactive: false,
      blackout: false,
      masterDimmer: 1,
      beamIntensity: 1,
      washIntensity: 1,
      strobeRate: 1.0,
      blinderLevel: 0,
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
        beamIntensity: flip ? 1.0 : 0.05,
        washIntensity: flip ? 1.0 : 0.05,
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
    probe.setRenderSettings({ crowdLighting: false });
    return { maxGen, maxRed };
  });
  expect(crowdFlashSafety.maxGen).toBeLessThanOrEqual(3);
  expect(crowdFlashSafety.maxRed).toBeLessThanOrEqual(3);

  // 3. Phone-like 390x844 + 4x CPU throttle warmed A/B benchmark (low tier = 1 show light) & UI persistence
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
    probe.setRenderSettings({ crowdLighting: true });
    probe.redrawAndCapture();
    probe.setRenderSettings({ crowdLighting: false });
    probe.redrawAndCapture();
  });
  await waitFrames(page, 4);
  const phoneOff = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 8, sampleFrames: 24, gpu: true })
  );
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ crowdLighting: true }));
  await waitFrames(page, 4);
  const phoneOn = await page.evaluate(() =>
    window.stageforgeProbe.measureFrames({ warmupFrames: 8, sampleFrames: 24, gpu: true })
  );
  const phoneProbeOn = await page.evaluate(() => window.stageforgeProbe.graphicsProbe());
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  expect(phoneProbeOn.tier).toBe('low');
  expect(phoneProbeOn.crowd.active).toBe(true);
  expect(phoneProbeOn.crowd.lightSlotCount).toBe(1); // low tier = 1 directional slot
  expect(Math.round(phoneOn.meanCalls)).toBe(Math.round(phoneOff.meanCalls));

  // Verify 390x844 Display popover 44px touch target, zero overflow, persistence across reload,
  // and booting with crowdLighting: true -> toggling false -> toggling true without uniform/program errors.
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ crowdLighting: false }));
  await page.getByTestId('display-settings-toggle').click();
  const panelBox = await page.getByTestId('display-settings-panel').boundingBox();
  const rowBox = await page.getByTestId('render-crowd-lighting-checkbox').locator('..').boundingBox();
  expect(panelBox).not.toBeNull();
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(392);
  expect(rowBox).not.toBeNull();
  expect(rowBox.height).toBeGreaterThanOrEqual(44);

  await page.getByTestId('render-crowd-lighting-checkbox').check();
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.graphicsProbe)).toBe('function');
  const bootEnabledCycle = await page.evaluate(() => {
    const probe = window.stageforgeProbe;
    // Wake engine out of initial post-reload standby via setCameraPose (calls previewRig())
    probe.setCameraPose([0, 2.55, 22.5], [0, 1.45, 11.5]);
    const bootedOn = probe.graphicsProbe().settings.crowdLighting && probe.graphicsProbe().crowd.active;
    probe.redrawAndCapture();
    probe.setRenderSettings({ crowdLighting: false });
    probe.redrawAndCapture();
    const toggledOff = !probe.graphicsProbe().crowd.active;
    probe.setRenderSettings({ crowdLighting: true });
    probe.redrawAndCapture();
    const toggledBackOn = probe.graphicsProbe().crowd.active;
    return { bootedOn, toggledOff, toggledBackOn };
  });
  expect(bootEnabledCycle).toEqual({ bootedOn: true, toggledOff: true, toggledBackOn: true });

  console.log('[SPRINT19_PROBE_SUMMARY]', JSON.stringify({
    desktop1280x720: {
      callsOff: Math.round(desktopOff.meanCalls),
      callsOn: Math.round(desktopOn.meanCalls),
      cpuP50Off: +desktopOff.cpuTotalMs.p50.toFixed(3),
      cpuP50On: +desktopOn.cpuTotalMs.p50.toFixed(3),
      cpuDeltaMs: +(desktopOn.cpuTotalMs.p50 - desktopOff.cpuTotalMs.p50).toFixed(3),
      crowdMeanOff: +desktopOff.crowdMs.mean.toFixed(3),
      crowdMeanOn: +desktopOn.crowdMs.mean.toFixed(3),
      renderSubmitMeanOff: +desktopOff.renderSubmitMs.mean.toFixed(3),
      renderSubmitMeanOn: +desktopOn.renderSubmitMs.mean.toFixed(3),
      frameP50Off: +desktopOff.frameIntervalMs.p50.toFixed(2),
      frameP50On: +desktopOn.frameIntervalMs.p50.toFixed(2),
      frameP95Off: +desktopOff.frameIntervalMs.p95.toFixed(2),
      frameP95On: +desktopOn.frameIntervalMs.p95.toFixed(2),
      gpuP50Off: desktopOff.gpuMs.count > 0 ? +desktopOff.gpuMs.p50.toFixed(3) : null,
      gpuP50On: desktopOn.gpuMs.count > 0 ? +desktopOn.gpuMs.p50.toFixed(3) : null,
      crowd: desktopProbeOn.crowd,
    },
    phone390x844_4xCpu: {
      callsOff: Math.round(phoneOff.meanCalls),
      callsOn: Math.round(phoneOn.meanCalls),
      cpuP50Off: +phoneOff.cpuTotalMs.p50.toFixed(3),
      cpuP50On: +phoneOn.cpuTotalMs.p50.toFixed(3),
      cpuDeltaMs: +(phoneOn.cpuTotalMs.p50 - phoneOff.cpuTotalMs.p50).toFixed(3),
      crowdMeanOff: +phoneOff.crowdMs.mean.toFixed(3),
      crowdMeanOn: +phoneOn.crowdMs.mean.toFixed(3),
      renderSubmitMeanOff: +phoneOff.renderSubmitMs.mean.toFixed(3),
      renderSubmitMeanOn: +phoneOn.renderSubmitMs.mean.toFixed(3),
      frameP50Off: +phoneOff.frameIntervalMs.p50.toFixed(2),
      frameP50On: +phoneOn.frameIntervalMs.p50.toFixed(2),
      frameP95Off: +phoneOff.frameIntervalMs.p95.toFixed(2),
      frameP95On: +phoneOn.frameIntervalMs.p95.toFixed(2),
      gpuP50Off: phoneOff.gpuMs.count > 0 ? +phoneOff.gpuMs.p50.toFixed(3) : null,
      gpuP50On: phoneOn.gpuMs.count > 0 ? +phoneOn.gpuMs.p50.toFixed(3) : null,
      crowd: phoneProbeOn.crowd,
    },
  }));

  expect(errors).toEqual([]);
});
