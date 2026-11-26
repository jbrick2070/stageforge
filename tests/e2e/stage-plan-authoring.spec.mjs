// Visual 2D authoring of screens, speaker hangs and the native layout in the Stage designer.
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const showFile = fileURLToPath(new URL('../fixtures/native-authoring-v3.stageforge.show.json', import.meta.url));

async function openShow(page) {
  await page.goto('/?probe');
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const files = page.getByRole('dialog', { name: 'Show files' });
  await files.getByLabel('Open show file').setInputFiles(showFile);
  await expect(files).toBeHidden();
  await expect.poll(async () => (await page.evaluate(() => window.stageforgeProbe.hangs())).length).toBe(2);
}

async function openDesigner(page) {
  await page.getByRole('button', { name: 'Design stage', exact: true }).first().click();
  const designer = page.getByRole('dialog', { name: 'Stage designer' });
  await expect(designer).toBeVisible();
  return designer;
}

const centre = async (locator) => {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

async function dragBy(page, locator, dx, dy) {
  const from = await centre(locator);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
  await page.mouse.up();
}

const field = (designer, label) => designer.getByLabel(label, { exact: true });
const numberIn = async (designer, label) => Number(await field(designer, label).inputValue());

test('Cancel leaves the live rig, screens and hangs untouched', async ({ page }) => {
  await openShow(page);
  const before = await page.evaluate(() => window.stageforgeProbe.hangs());
  const screensBefore = await page.evaluate(() => window.stageforgeProbe.screens().map(s => s.id));
  let designer = await openDesigner(page);
  await dragBy(page, designer.locator('[data-item="wall"][data-id="side-led"] > polygon:not(.sd-hit)'), 120, 40);
  await dragBy(page, designer.locator('[data-item="hang"][data-id="1"] > polygon'), -80, 0);
  await designer.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(designer).toBeHidden();
  expect(await page.evaluate(() => window.stageforgeProbe.hangs())).toEqual(before);
  expect(await page.evaluate(() => window.stageforgeProbe.screens().map(s => s.id))).toEqual(screensBefore);

  designer = await openDesigner(page);
  await designer.getByLabel('Plan objects').selectOption('w:side-led');
  expect(await numberIn(designer, 'Center X')).toBe(4.25);
  expect(await numberIn(designer, 'Yaw')).toBe(-18);
  await designer.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('drag, aim and resize screens and hangs on the plan, edit the layout, and keep wall cues', async ({ page }, info) => {
  test.setTimeout(120_000);
  await openShow(page);
  const designer = await openDesigner(page);

  // Every overlay object in the v3 fixture is on the plan.
  await expect(designer.locator('.sd-object[data-item="wall"]')).toHaveCount(2);
  await expect(designer.locator('.sd-object[data-item="hang"]')).toHaveCount(2);
  await expect(designer.locator('.sd-object[data-item="span"]')).toHaveCount(1);
  await expect(designer.locator('.sd-object[data-item="prop"]')).toHaveCount(1);
  await expect(designer.getByLabel('Stage right screen, facing -18°')).toHaveCount(1);

  // Drag the stage-right screen downstage and to the right.
  await dragBy(page, designer.locator('[data-item="wall"][data-id="side-led"] > polygon:not(.sd-hit)'), 60, 60);
  await expect(field(designer, 'Center X')).toBeVisible();
  const movedX = await numberIn(designer, 'Center X');
  const movedZ = await numberIn(designer, 'Center Z');
  expect(movedX).toBeGreaterThan(4.25);
  expect(movedZ).toBeGreaterThan(-1.95);

  // Aim it by dragging its arrow handle far to the left: it turns to face −X (about −90°).
  const aim = designer.locator('[data-item="wall"][data-node="1"] circle').last();
  await dragBy(page, aim, -260, 0);
  const yaw = await numberIn(designer, 'Yaw');
  expect(yaw).toBeLessThan(-60);
  expect(Math.abs(yaw % 5)).toBe(0); // the angle snaps to 5° with grid snap on
  await field(designer, 'Screen width').fill('2.5');
  await field(designer, 'Screen width').press('Enter');

  // Re-aim the 7-box hang from its arrow and add boxes.
  await designer.getByLabel('Plan objects').selectOption('h:1');
  expect(await numberIn(designer, 'Aim')).toBe(-21);
  await dragBy(page, designer.locator('[data-item="hang"][data-node="0"] circle').last(), 0, 200);
  const hangAim = await numberIn(designer, 'Aim');
  expect(Math.abs(hangAim)).toBeLessThan(20);
  await field(designer, 'Boxes').fill('9');
  await field(designer, 'Boxes').press('Enter');

  // Place a new secondary screen with the Screen tool.
  await designer.getByRole('button', { name: 'Screen', exact: true }).click();
  const plan = designer.getByRole('application', { name: 'Stage plan in metres' });
  const box = await plan.boundingBox();
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.45);
  await expect(designer.locator('.sd-object[data-item="wall"]')).toHaveCount(3);
  expect(await field(designer, 'Screen label').inputValue()).toBe('Stage left');

  // Native layout: lengthen the truss and turn the inflatable into scenery.
  await designer.getByLabel('Plan objects').selectOption('s:0');
  await field(designer, 'End X').fill('3');
  await field(designer, 'End X').press('Enter');
  await designer.getByLabel('Plan objects').selectOption('o:0');
  await designer.getByLabel('Prop type', { exact: true }).selectOption('scenic');

  await designer.getByRole('button', { name: 'Apply design' }).click();
  await expect(designer).toBeHidden();

  // 3D picks up the hang and the new screen; the imported wall cues still play.
  await expect.poll(async () => (await page.evaluate(() => window.stageforgeProbe.hangs())).find(h => h.cabinets === 9)?.yaw)
    .toBe(hangAim);
  await expect.poll(async () => (await page.evaluate(() => window.stageforgeProbe.screens())).map(s => s.id).sort())
    .toEqual(['side-led', 'wall-2']);
  await page.getByRole('button', { name: 'Show cues', exact: true }).click();
  await page.getByRole('slider', { name: 'Take position' }).fill('8500');
  await expect.poll(async () => (await page.evaluate(() => window.stageforgeProbe.screens())).find(s => s.id === 'side-led'))
    .toMatchObject({ name: 'guest-surface.mp4' });

  // The saved show is v3 and carries every plan edit plus the original wall cues.
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const files = page.getByRole('dialog', { name: 'Show files' });
  const transfer = page.waitForEvent('download');
  await files.getByRole('button', { name: 'Save show JSON' }).click();
  const download = await transfer;
  const path = info.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  const show = JSON.parse(await readFile(path, 'utf8'));
  expect(show.version).toBe(3);
  const side = show.stage.walls.find(w => w.id === 'side-led');
  expect(side).toMatchObject({ x: movedX, z: movedZ, yaw, width: 2.5, label: 'Stage right' });
  expect(show.stage.walls.map(w => w.id)).toEqual(['main-led', 'side-led', 'wall-2']);
  expect(show.stage.layout.hangs[1]).toMatchObject({ count: 9, yaw: hangAim, tilt: -8, splay: 5.5 });
  expect(show.stage.layout.trusses[0]).toEqual({ x: -2, z: -1, endX: 3, endZ: 2, height: 4 });
  expect(show.stage.layout.props[0]).toEqual({ x: 2, z: 2, type: 'scenic', height: 2 });
  expect(show.stage.screenEvents).toHaveLength(5);
});

test('replace layout, convert a layout truss to a rig truss, and undo stage edits', async ({ page }) => {
  await openShow(page);
  const designer = await openDesigner(page);
  await designer.getByLabel('Plan objects').selectOption('s:0');
  await designer.getByRole('button', { name: 'Convert to rig truss' }).click();
  await expect(designer.locator('.sd-object[data-item="span"]')).toHaveCount(0);
  await expect(designer.getByRole('status')).toContainText('is now a rig truss');
  await expect(field(designer, 'Elevation')).toHaveValue('4');

  await designer.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(designer.locator('.sd-object[data-item="span"]')).toHaveCount(1);

  await designer.getByLabel('Plan objects').selectOption('');
  await designer.getByLabel('Replace rig layout').check();
  await expect(designer.locator('.sd-platform.sd-replaced').first()).toBeVisible();
  await designer.getByLabel('Plan objects').selectOption('s:0');
  await expect(designer.getByRole('button', { name: 'Convert to rig truss' })).toBeDisabled();

  await designer.getByRole('button', { name: 'Apply design' }).click();
  await expect(designer).toBeHidden();
  // With replace on, only the authored hangs build; the rig's stock geometry is hidden.
  await expect.poll(async () => (await page.evaluate(() => window.stageforgeProbe.hangs())).length).toBe(2);
});

test('a new blank design asks before replacing the overlay and its wall cues, and declining keeps the draft', async ({ page }, info) => {
  await openShow(page);
  const designer = await openDesigner(page);
  await designer.getByRole('button', { name: 'New blank design' }).click();
  await designer.getByRole('button', { name: 'Screen', exact: true }).click();
  await designer.getByRole('button', { name: 'Place at default position' }).click();
  await expect(designer.locator('.sd-object[data-item="wall"]')).toHaveCount(1);

  let prompt = '';
  page.once('dialog', (dialog) => { prompt = dialog.message(); void dialog.dismiss(); });
  await designer.getByRole('button', { name: 'Apply design' }).click();
  await expect.poll(() => prompt).toContain('5 wall cues');
  await expect(designer).toBeVisible();
  await expect(designer.locator('.sd-object[data-item="wall"]')).toHaveCount(1);

  page.once('dialog', (dialog) => void dialog.accept());
  await designer.getByRole('button', { name: 'Apply design' }).click();
  await expect(designer).toBeHidden();
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const files = page.getByRole('dialog', { name: 'Show files' });
  const transfer = page.waitForEvent('download');
  await files.getByRole('button', { name: 'Save show JSON' }).click();
  const path = info.outputPath('blank.stageforge.show.json');
  await (await transfer).saveAs(path);
  const show = JSON.parse(await readFile(path, 'utf8'));
  expect(show.stage.walls.map(w => w.id)).toEqual(['side-led']);
  expect(show.stage.screenEvents).toEqual([]);
});

test('undo clears an index selection, and Delete never removes the rig LED wall', async ({ page }) => {
  await page.goto('/?probe');
  const designer = await openDesigner(page);
  await designer.getByRole('button', { name: 'Speaker hang', exact: true }).click();
  const plan = designer.getByRole('application', { name: 'Stage plan in metres' });
  const box = await plan.boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.7);
  await expect(field(designer, 'Boxes')).toBeVisible();
  await designer.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(designer.getByLabel('Replace rig layout')).toBeVisible();
  await expect(field(designer, 'Boxes')).toHaveCount(0);

  await designer.getByLabel('Plan objects').selectOption('w:main-led');
  await expect(designer.getByRole('button', { name: 'Reset to rig LED wall' })).toBeDisabled();
  await plan.focus();
  await page.keyboard.press('Delete');
  await expect(designer.getByRole('status')).toContainText('comes from the rig');
  await expect(designer.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); // Delete added no history entry
  await expect(designer.locator('.sd-object[data-item="wall"]')).toHaveCount(1);
  await designer.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('authored crowd drafts cancel, apply, save offline, and stay isolated through Pitch Viewer', async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.goto('/?probe');
  let designer = await openDesigner(page);
  await designer.getByLabel('Authored crowd').check();
  await expect(designer.getByTestId('crowd-editor')).toContainText('reproducible people');
  await expect(designer.getByTestId('crowd-plan-overlay')).toBeVisible();
  await designer.getByLabel('Crowd generator seed').fill('123');
  await designer.getByLabel('Crowd zone occupancy').fill('0.2');
  await designer.getByRole('button', { name: 'Add centre aisle' }).click();
  await expect(designer.getByTestId('crowd-editor')).toContainText('1 exclusion');
  await designer.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(designer.getByTestId('crowd-editor')).toContainText('0 exclusions');
  await designer.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => window.stageforgeProbe.crowd().authored)).toBe(false);

  designer = await openDesigner(page);
  await designer.getByLabel('Authored crowd').check();
  await designer.getByLabel('Crowd generator seed').fill('123');
  await designer.getByLabel('Crowd zone occupancy').fill('0.2');
  await designer.getByRole('button', { name: 'Add centre aisle' }).click();
  await designer.getByRole('button', { name: 'Apply design' }).click();
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.crowd().authored)).toBe(true);
  const savedCrowd = await page.evaluate(() => window.stageforgeProbe.crowd());
  expect(savedCrowd.count).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  let files = page.getByRole('dialog', { name: 'Show files' });
  const transfer = page.waitForEvent('download');
  await files.getByRole('button', { name: 'Save show JSON' }).click();
  const path = info.outputPath('authored-crowd.stageforge.show.json');
  await (await transfer).saveAs(path);
  const show = JSON.parse(await readFile(path, 'utf8'));
  expect(show.version).toBe(10);
  expect(show.crowd).toMatchObject({ generatorVersion: 1, seed: 123 });
  expect(show.crowd.exclusions).toHaveLength(1);
  await files.getByRole('button', { name: 'Close Show files' }).click();

  // Keep a distinct live desk revision; viewer loads the saved revision and Exit must restore this one.
  designer = await openDesigner(page);
  await designer.getByLabel('Crowd generator seed').fill('456');
  await designer.getByRole('button', { name: 'Apply design' }).click();
  const deskCrowd = await page.evaluate(() => window.stageforgeProbe.crowd());
  expect(deskCrowd.transforms).not.toEqual(savedCrowd.transforms);

  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  files = page.getByRole('dialog', { name: 'Show files' });
  await files.getByLabel('Open show in viewer').setInputFiles(path);
  await expect(page.getByText('VIEW ONLY', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.crowd().authored)).toBe(true);
  expect((await page.evaluate(() => window.stageforgeProbe.crowd())).transforms).toEqual(savedCrowd.transforms);
  await page.getByRole('button', { name: 'Exit viewer' }).click();
  await expect(page.getByText('VIEW ONLY', { exact: true })).toHaveCount(0);
  expect((await page.evaluate(() => window.stageforgeProbe.crowd())).transforms).toEqual(deskCrowd.transforms);
});
