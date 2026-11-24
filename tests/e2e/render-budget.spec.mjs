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
  await page.getByRole('button', { name: /play demo/i }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await expect.poll(async () => (await frameStats(page)).calls).toBeGreaterThan(0);

  const on = await frameStats(page);
  await page.evaluate(() => window.stageforgeProbe.setBatching(false));
  const off = await frameStats(page);
  await page.evaluate(() => window.stageforgeProbe.setBatching(true));
  const again = await frameStats(page);

  // The default arena rig: hundreds of repeated yokes, housings, clamps, hoists, cabinets and lamps.
  expect(on.batching.instances).toBeGreaterThan(300);
  expect(on.batching.released).toBe(0);
  expect(on.calls).toBeLessThan(off.calls * 0.4);
  expect(on.calls).toBeLessThanOrEqual(250);
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
