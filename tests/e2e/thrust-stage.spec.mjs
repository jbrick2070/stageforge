import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('the exported club thrust stage supports all four wedges and fits the LED frame below the grid', async ({ page }) => {
  const show = JSON.parse(await readFile(new URL('../../public/examples/amber-walk-on.stageforge.show.json', import.meta.url)));
  Object.assign(show.rig, { stageWidth: 12, stageDepth: 12, stageHeight: 1, platforms: [
    { id: 'main', name: 'Main', x: 2, z: -1, width: 12, depth: 6, height: 1 },
    { id: 'thrust', name: 'Thrust', x: 2, z: 4, width: 4, depth: 4, height: 1 },
  ] });
  Object.assign(show.rig.ledWall, { width: 12, height: 7.5, curved: false });
  Object.assign(show.rig.audioRig, { monitorCount: 4, speakerProfile: 'k2' });
  await page.goto('/');
  const files = page.getByRole('dialog', { name: 'Show files' });
  const openFiles = page.getByRole('button', { name: 'Show files', exact: true });
  await openFiles.click();
  await files.getByLabel('Open show file').setInputFiles({ name: 'Club.stageforge.show.json',
    mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(show)) });
  await expect(files).toBeHidden();
  await openFiles.click();
  const download = page.waitForEvent('download');
  await files.getByRole('button', { name: '3D scene GLB' }).click();
  const glb = await readFile(await (await download).path());
  const json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
  const node = name => json.nodes.find(n => n.name === name);
  const origin = n => n.translation ?? n.matrix.slice(12, 15);
  for (const [index, front] of [1.35, 5.35, 5.35, 1.35].entries()) {
    const position = origin(node(`Monitor wedge ${index + 1}`));
    expect(position[1]).toBe(1);
    expect(position[2]).toBeCloseTo(front, 4);
  }
  const wall = node('LED wall');
  expect(origin(wall)[0]).toBe(2);
  expect(origin(wall)[2]).toBeCloseTo(-3.6);
  const housing = node('LED wall housing');
  const positions = json.meshes[housing.mesh].primitives[0].attributes.POSITION;
  expect(origin(housing)[1] + json.accessors[positions].max[1]).toBeLessThanOrEqual(5.2);
  await files.getByRole('button', { name: 'Close Show files' }).click();
  await page.getByRole('button', { name: 'Design stage', exact: true }).click();
  const designer = page.getByRole('dialog', { name: 'Stage designer' });
  await designer.getByRole('button', { name: 'Truss path', exact: true }).click();
  const elevation = designer.getByLabel('Truss elevation', { exact: true });
  await expect(elevation).toHaveValue('4.4');
  await elevation.fill('6');
  await elevation.press('Tab');
  await expect(designer).toContainText('less than 0.3 m overhead clearance');
});
