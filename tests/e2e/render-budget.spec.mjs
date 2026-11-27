import { playSynthDemo } from '../support/play-synth-demo.mjs';
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/** Two animation frames, then the whole-frame render stats (scene, bloom and output passes). */
const frameStats = (page) => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.stageforgeProbe.renderStats())));
}));

/** Export the 3D scene GLB and return its glTF JSON. */
async function exportGlb(page) {
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const files = page.getByRole('dialog', { name: 'Show files' });
  const download = page.waitForEvent('download');
  await files.getByRole('button', { name: '3D scene GLB' }).click();
  const glb = await readFile(await (await download).path());
  await files.getByRole('button', { name: 'Close Show files' }).click();
  await expect(files).toBeHidden();
  return JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
}

test('repeated rig parts draw as instanced batches: far fewer draw calls, same picture, same exports, no leaks', async ({ page }) => {
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.renderStats)).toBe('function');
  await playSynthDemo(page);
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await expect.poll(async () => (await frameStats(page)).calls).toBeGreaterThan(0);

  const on = await frameStats(page);
  await page.evaluate(() => window.stageforgeProbe.setBatching(true, { proxies: false }));
  const beamsOff = await frameStats(page);
  await page.evaluate(() => window.stageforgeProbe.setBatching(false));
  const off = await frameStats(page);
  await page.evaluate(() => window.stageforgeProbe.setBatching(true));
  const again = await frameStats(page);

  // The default arena rig: hundreds of repeated yokes, housings, clamps, hoists, cabinets, lamps and 44 beam cones.
  expect(on.batching.instances).toBeGreaterThan(300);
  expect(on.batching.proxied).toBe(44);
  expect(on.batching.released).toBe(0);
  expect(on.calls).toBeLessThan(off.calls * 0.4);
  expect(on.calls).toBeLessThanOrEqual(140);
  expect(beamsOff.calls - on.calls).toBeGreaterThanOrEqual(40);
  // The default front-of-house view sees the whole rig, so batching changes how parts are drawn, not what
  // is drawn. (Blackout can't freeze the frame: it puts the engine in standby. Beams switch on and off as the
  // cue runs, hence the small tolerances.)
  expect(Math.abs(on.triangles - off.triangles)).toBeLessThan(off.triangles * 0.05);
  expect(Math.abs(again.calls - on.calls)).toBeLessThanOrEqual(Math.ceil(on.calls * 0.1));

  // Exports read the rig, never the batches: the GLB is the same with batching on and off.
  const glbOn = await exportGlb(page);
  await page.evaluate(() => window.stageforgeProbe.setBatching(false));
  const glbOff = await exportGlb(page);
  await page.evaluate(() => window.stageforgeProbe.setBatching(true));
  expect(glbOn.nodes.length).toBe(glbOff.nodes.length);
  expect(glbOn.meshes.length).toBe(glbOff.meshes.length);
  expect(glbOn.nodes.some((node) => /^Batch:/.test(node.name ?? ''))).toBe(false);

  // Rebuilding the rig repeatedly with batching on leaks neither geometry nor textures.
  const leak = await page.evaluate(async () => {
    const next = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.stageforgeProbe.rebuildRig();
    await next();
    const before = window.stageforgeProbe.renderStats();
    for (let i = 0; i < 8; i++) {
      window.stageforgeProbe.rebuildRig();
      await next();
    }
    return { before, after: window.stageforgeProbe.renderStats() };
  });
  expect(leak.after.geometries).toBeLessThanOrEqual(leak.before.geometries + 2);
  expect(leak.after.textures).toBe(leak.before.textures);
  expect(leak.after.batching.batches).toBe(leak.before.batching.batches);
});

test('frozen-frame pixel parity: instanced beams match unbatched rendering within 1% on Arena Rock and Laser Tunnel', async ({ page }) => {
  const glErrors = [];
  page.on('pageerror', (err) => glErrors.push(err.message));
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' || /THREE\.WebGLProgram/i.test(text)) glErrors.push(text);
  });

  await page.clock.install();
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.redrawAndCapture)).toBe('function');
  await playSynthDemo(page);

  const checkPresetParity = async (presetName) => {
    await page.getByRole('button', { name: new RegExp(presetName) }).first().click();
    await expect.poll(async () => page.evaluate(() =>
      window.stageforgeProbe.beamAxes().filter((b) => b.optics.emitted > 0.001).length
    )).toBeGreaterThanOrEqual(40);

    // Freeze time slightly ahead of the live clock (so CDP round-trip never lands in the past)
    // and advance exactly one frame so batching on/off render the identical scene state.
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
    await page.clock.runFor(16);

    const parity = await page.evaluate(async () => {
      const decode = (url) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
        };
        img.onerror = reject;
        img.src = url;
      });
      const meanAbsDiff = (a, b) => {
        let sum = 0;
        for (let i = 0; i < a.data.length; i += 4) {
          sum += Math.abs(a.data[i] - b.data[i])
            + Math.abs(a.data[i + 1] - b.data[i + 1])
            + Math.abs(a.data[i + 2] - b.data[i + 2]);
        }
        return sum / (a.width * a.height * 3 * 255);
      };

      const probe = window.stageforgeProbe;
      probe.setBatching(true, { proxies: true });
      const imgOn = probe.redrawAndCapture();
      const statsOn = probe.renderStats();
      const litBeams = probe.beamAxes().filter((b) => b.optics.emitted > 0.001).length;
      const imgNoBeams = probe.redrawAndCapture({ hideBeams: true });

      probe.setBatching(true, { proxies: false });
      const imgBeamsOff = probe.redrawAndCapture();
      const statsBeamsOff = probe.renderStats();

      probe.setBatching(false, { proxies: false });
      const imgOff = probe.redrawAndCapture();
      const statsOff = probe.renderStats();

      probe.setBatching(true, { proxies: true });

      const [onData, noBeamsData, beamsOffData, offData] = await Promise.all([
        decode(imgOn), decode(imgNoBeams), decode(imgBeamsOff), decode(imgOff),
      ]);
      return {
        litBeams,
        statsOn,
        statsBeamsOff,
        statsOff,
        beamSignal: meanAbsDiff(onData, noBeamsData),
        diffOnVsOff: meanAbsDiff(onData, offData),
        diffOnVsBeamsOff: meanAbsDiff(onData, beamsOffData),
      };
    });

    await page.clock.resume();
    return parity;
  };

  const arena = await checkPresetParity('Arena Rock');
  expect(arena.litBeams).toBeGreaterThanOrEqual(40);
  expect(arena.statsOn.batching.proxied).toBe(44);
  expect(arena.statsOn.batching.released).toBe(0);
  expect(arena.statsOn.calls).toBeLessThanOrEqual(140);
  expect(arena.statsBeamsOff.calls - arena.statsOn.calls).toBeGreaterThanOrEqual(40);
  // Prove beams themselves move the image well past the 1% tolerance, and instanced vs unbatched matches tightly.
  expect(arena.beamSignal).toBeGreaterThan(0.02);
  expect(arena.diffOnVsOff).toBeLessThan(0.01);
  expect(arena.diffOnVsOff).toBeLessThan(arena.beamSignal * 0.1);
  expect(arena.diffOnVsBeamsOff).toBeLessThan(0.01);
  expect(arena.diffOnVsBeamsOff).toBeLessThan(arena.beamSignal * 0.1);

  // Also verify Laser Tunnel (goboPrism enabled: 8-shaft prism loop, uSeed, m[0]/m[2] azimuth basis).
  const laser = await checkPresetParity('Laser Tunnel');
  expect(laser.litBeams).toBeGreaterThanOrEqual(40);
  expect(laser.statsOn.batching.proxied).toBe(44);
  expect(laser.statsOn.batching.released).toBe(0);
  expect(laser.statsBeamsOff.calls - laser.statsOn.calls).toBeGreaterThanOrEqual(40);
  expect(laser.beamSignal).toBeGreaterThan(0.005);
  expect(laser.diffOnVsOff).toBeLessThan(0.01);
  expect(laser.diffOnVsOff).toBeLessThan(laser.beamSignal * 0.1);
  expect(laser.diffOnVsBeamsOff).toBeLessThan(0.01);
  expect(laser.diffOnVsBeamsOff).toBeLessThan(laser.beamSignal * 0.1);

  expect(glErrors).toEqual([]);
});
